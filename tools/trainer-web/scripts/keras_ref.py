#!/usr/bin/env python3
"""
Exporter cross-check, step 1: train the trainer-web architecture in Keras, then write
  <out>/weights.json   raw weights in the layout src/lib/tflite/export.js expects
  <out>/calib.json     calibration crops (raw 0..255, HWC) for the JS exporter
  <out>/test.npz       test crops + labels for compare_tflite.py
  <out>/tfconv_q.tflite  the same network through the official TFLite converter (int8)

--data is an .npz with X (N x 32 x 20 x 3, raw RGB), Y (N x 10 soft targets), W (sample
weight, 0 = unused), split ("train" / "test") and src (source meter). Needs TensorFlow + Keras:
  python tools/trainer-web/scripts/keras_ref.py --data dataset.npz --out tools/trainer-web/check-out --epochs 8
"""
import argparse
import json
import os

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
import numpy as np  # noqa: E402
import tensorflow as tf  # noqa: E402
import keras  # noqa: E402
from keras import layers  # noqa: E402

INPUT_SCALE = 1 / 255.0
ALPHA = 0.3


def build(filters=(24, 48, 48), dense=(128, 64)):
    inp = keras.Input((32, 20, 3))
    x = inp
    for n in filters:
        x = layers.Conv2D(n, 3, padding="same")(x)
        x = layers.BatchNormalization(epsilon=1e-3)(x)
        x = layers.LeakyReLU(negative_slope=ALPHA)(x)
        x = layers.MaxPooling2D(2)(x)
    x = layers.Flatten()(x)
    for n in dense:
        x = layers.Dense(n)(x)
        x = layers.LeakyReLU(negative_slope=ALPHA)(x)
    out = layers.Dense(10, activation="softmax")(x)
    return keras.Model(inp, out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--epochs", type=int, default=8)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    keras.utils.set_random_seed(1)

    d = np.load(a.data)
    tr = (d["split"] == "train") & (d["W"] > 0)
    te = (d["split"] == "test") & (d["W"] > 0) & (d["src"] != "public")
    X, Y = d["X"][tr].astype(np.float32), d["Y"][tr]
    model = build()
    model.compile(keras.optimizers.Adam(1e-3), "categorical_crossentropy", metrics=["accuracy"])
    model.fit(X * INPUT_SCALE, Y, batch_size=64, epochs=a.epochs, validation_split=0.08, verbose=2)

    convs, denses = [], []
    ls = model.layers
    for i, l in enumerate(ls):
        if isinstance(l, layers.Conv2D):
            k, b = l.get_weights()
            bn = ls[i + 1]
            g, be, m, v = bn.get_weights()
            convs.append(dict(kernel=k.ravel().tolist(), bias=b.tolist(),
                              bn=dict(gamma=g.tolist(), beta=be.tolist(), mean=m.tolist(),
                                      variance=v.tolist(), eps=float(bn.epsilon))))
        elif isinstance(l, layers.Dense):
            k, b = l.get_weights()
            denses.append(dict(kernel=k.ravel().tolist(), bias=b.tolist()))
    json.dump(dict(inputShape=[32, 20, 3], inputScale=INPUT_SCALE, alpha=ALPHA, convs=convs, denses=denses),
              open(os.path.join(a.out, "weights.json"), "w"))

    rng = np.random.default_rng(0)
    calib = X[rng.choice(len(X), 300, replace=False)]
    json.dump([c.ravel().round(3).tolist() for c in calib], open(os.path.join(a.out, "calib.json"), "w"))
    np.savez_compressed(os.path.join(a.out, "test.npz"), X=d["X"][te].astype(np.float32), Y=d["Y"][te],
                        src=d["src"][te], pos=d["pos"][te],
                        keras=model.predict(d["X"][te].astype(np.float32) * INPUT_SCALE, verbose=0))

    # official converter on the same network, raw 0..255 float input like the firmware feeds
    raw_in = keras.Input((32, 20, 3))
    full = keras.Model(raw_in, model(layers.Rescaling(INPUT_SCALE)(raw_in)))

    def rep():
        for c in calib[:200]:
            yield [c[None]]
    conv = tf.lite.TFLiteConverter.from_keras_model(full)
    conv.optimizations = [tf.lite.Optimize.DEFAULT]
    conv.representative_dataset = rep
    conv.target_spec.supported_ops = [tf.lite.OpsSet.TFLITE_BUILTINS_INT8]
    conv.inference_input_type = tf.float32
    conv.inference_output_type = tf.float32
    open(os.path.join(a.out, "tfconv_q.tflite"), "wb").write(conv.convert())
    print("written to", a.out)


if __name__ == "__main__":
    main()
