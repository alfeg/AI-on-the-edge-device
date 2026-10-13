#pragma once

#ifndef PUBLISHGATE_H
#define PUBLISHGATE_H

// Publish gate: the final, publish-only filter for one number sequence.
//
// It decides only WHAT IS PUBLISHED (MQTT / InfluxDB / Webhook / REST value).
// PreValue, the rate guards and prevalue.ini are untouched by it. Guarantees:
//   - a published value never decreases,
//   - a published value never rises faster than MaxRate * elapsed + Slack,
//   - on doubt nothing is published (hold).
// A stable cluster of `escape` agreeing rejected readings re-anchors the gate
// upward; a downward re-anchor needs `escapeDown` rejected cycles and still
// publishes nothing until the reading climbs back above the last published value.
//
// Port of policy_gate_db in tools/meter-replay/replay.py. Deliberately free of
// ESP-IDF / logging dependencies so it builds with a host compiler.

#include <vector>
#include <algorithm>
#include <ctime>

struct PublishGateConfig {
    bool enabled = false;
    double maxRatePerMin = 0.03;  // physical upper bound, units per minute
    double slack = 0.02;          // absolute tolerance added to the rate limit
    double deadband = 0.1;        // readings this far below the anchor count as "unchanged"
    int escape = 3;               // agreeing rejected readings needed to re-anchor
    int escapeDown = 12;          // rejected cycles needed before a downward re-anchor
};

class PublishGate {
public:
    enum Action {
        NoReading,       // no numeric reading this cycle
        First,           // no anchor yet: reading taken as anchor
        Accepted,        // reading within [anchor, anchor + limit]
        Deadband,        // reading slightly below anchor: anchor republished
        Held,            // reading outside the window: held pending
        ReAnchoredUp,    // agreeing held readings moved the anchor up
        ReAnchoredDown   // agreeing held readings moved the anchor down
    };

    struct Result {
        bool publish;     // true: publish `value`; false: publish nothing this cycle
        double value;
        Action action;
        bool decreaseSuppressed;  // a candidate was dropped because it was below the last published value
    };

    // Seed from a trusted previous value (e.g. prevalue.ini at startup), so the
    // first cycle after a reboot cannot publish a decrease.
    void seed(double value, time_t t) {
        anchorValid = true;
        anchorValue = value;
        anchorTime = t;
        lastPubValid = true;
        lastPub = value;
        pend.clear();
    }

    Result step(const PublishGateConfig& cfg, bool valid, double v, time_t t) {
        Result r = { false, 0.0, NoReading, false };
        bool havePub = false;
        double pubv = 0.0;

        if (valid) {
            if (!anchorValid) {
                anchorValid = true;
                anchorValue = v;
                anchorTime = t;
                havePub = true;
                pubv = v;
                r.action = First;
            }
            else {
                double mins = difftime(t, anchorTime) / 60.0;
                if (mins < 1.0) {
                    mins = 1.0;
                }
                double lim = cfg.maxRatePerMin * mins + cfg.slack;
                double d = v - anchorValue;

                if ((-cfg.deadband <= d) && (d < 0)) {
                    r.action = Deadband;
                    if (lastPubValid) {
                        havePub = true;
                        pubv = anchorValue;
                    }
                    pend.clear();
                }
                else if ((0 <= d) && (d <= lim)) {
                    r.action = Accepted;
                    anchorValue = v;
                    anchorTime = t;
                    pend.clear();
                    havePub = true;
                    pubv = v;
                }
                else {
                    r.action = Held;
                    pend.push_back(v);

                    size_t cap = 32;
                    if (cfg.escape > 0 && (size_t) cfg.escape > cap) cap = (size_t) cfg.escape;
                    if (cfg.escapeDown > 0 && (size_t) cfg.escapeDown > cap) cap = (size_t) cfg.escapeDown;
                    if (pend.size() > cap) {
                        pend.erase(pend.begin(), pend.end() - cap);
                    }

                    if ((cfg.escape > 0) && (pend.size() >= (size_t) cfg.escape)) {
                        std::vector<double> recent(pend.end() - cfg.escape, pend.end());
                        std::sort(recent.begin(), recent.end());

                        if (recent.back() - recent.front() <= cfg.slack * 2) {
                            size_t n = recent.size();
                            double cand = (n % 2 == 1) ? recent[n / 2]
                                                       : (recent[n / 2 - 1] + recent[n / 2]) / 2.0;

                            if ((cand > anchorValue) || ((int) pend.size() >= cfg.escapeDown)) {
                                r.action = (cand > anchorValue) ? ReAnchoredUp : ReAnchoredDown;
                                anchorValue = cand;
                                anchorTime = t;
                                pend.clear();
                                havePub = true;
                                pubv = cand;
                            }
                        }
                    }
                }
            }
        }

        if (havePub && lastPubValid && (pubv < lastPub)) {
            r.decreaseSuppressed = true;   // never publish a decrease
            if (lastPub - pubv <= cfg.deadband) {
                pubv = lastPub;            // within the dead-band: republish the last value as "unchanged"
            }
            else {
                havePub = false;
            }
        }

        if (havePub) {
            lastPubValid = true;
            lastPub = pubv;
            r.publish = true;
            r.value = pubv;
        }

        return r;
    }

    bool hasAnchor() const { return anchorValid; }
    double getAnchor() const { return anchorValue; }
    bool hasLastPublished() const { return lastPubValid; }
    double getLastPublished() const { return lastPub; }
    size_t pendingCount() const { return pend.size(); }

private:
    bool anchorValid = false;
    double anchorValue = 0.0;
    time_t anchorTime = 0;
    bool lastPubValid = false;
    double lastPub = 0.0;
    std::vector<double> pend;
};

#endif // PUBLISHGATE_H
