#!/usr/bin/env python3
"""
Train the digit-wheel model (DoubleHyprid10 head: 10-way softmax, soft targets).

Architecture mirrors sd-card/config/dig-cont_0900_s3_q.tflite:
  in 32x20x3 raw RGB 0..255 -> BN (input normalisation, becomes MUL+ADD)
  3x [Conv3x3 same -> LeakyReLU -> BN -> MaxPool2]   (64, 128, 64 filters)
  Flatten -> Dense256 -> LeakyReLU -> Dense64 -> LeakyReLU -> Dense10 softmax
Dropout is training-only (no TFLite op).

Only the TRAIN split of dataset.npz is used; 8% of it (random, fixed seed) is a
validation set for checkpoint selection. The test split is never touched here.

Run: tools/meter-train/.venv/Scripts/python tools/meter-train/train.py [--epochs 60]
"""
import argparse
import os
import time

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
import numpy as np  # noqa: E402
import tensorflow as tf  # noqa: E402
import keras  # noqa: E402
from keras import layers  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
TRAIN_DIR = os.path.join(ROOT, "device-logs", "train")


def build_model(width=1.0, dropout=0.25):
    f = [int(64 * width), int(128 * width), int(64 * width)]
    inp = keras.Input((32, 20, 3), name="image")
    x = layers.BatchNormalization()(inp)
    for n in f:
        x = layers.Conv2D(n, 3, padding="same")(x)
        x = layers.LeakyReLU()(x)
        x = layers.BatchNormalization()(x)
        x = layers.MaxPooling2D(2)(x)
    x = layers.Flatten()(x)
    x = layers.Dropout(dropout)(x)
    x = layers.Dense(256)(x)
    x = layers.LeakyReLU()(x)
    x = layers.Dropout(dropout)(x)
    x = layers.Dense(64)(x)
    x = layers.LeakyReLU()(x)
    out = layers.Dense(10, activation="softmax")(x)
    return keras.Model(inp, out)


def augment(x, y, w):
    """x: float32 32x20x3 in 0..255. Light, label-preserving augmentation (no flips)."""
    # shift +-2 px (edge-replicated border)
    x = tf.pad(x, [[2, 2], [2, 2], [0, 0]], mode="SYMMETRIC")
    x = tf.image.random_crop(x, [32, 20, 3])
    # slight blur, 30% of the time
    k = tf.constant([[1, 2, 1], [2, 4, 2], [1, 2, 1]], tf.float32) / 16.0
    k = tf.tile(k[:, :, None, None], [1, 1, 3, 1])
    blurred = tf.nn.depthwise_conv2d(x[None], k, [1, 1, 1, 1], "SAME")[0]
    x = tf.where(tf.random.uniform([]) < 0.3, blurred, x)
    # brightness / contrast / per-channel gain / noise
    mean = tf.reduce_mean(x)
    x = (x - mean) * tf.random.uniform([], 0.7, 1.3) + mean
    x = x + tf.random.uniform([], -30.0, 30.0)
    x = x * tf.random.uniform([1, 1, 3], 0.9, 1.1)
    x = x + tf.random.normal(tf.shape(x), 0.0, 3.0)
    return tf.clip_by_value(x, 0.0, 255.0), y, w


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.path.join(TRAIN_DIR, "data", "dataset.npz"))
    ap.add_argument("--out", default=os.path.join(TRAIN_DIR, "models", "dig-meter.keras"))
    ap.add_argument("--epochs", type=int, default=60)
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--width", type=float, default=1.0)
    ap.add_argument("--seed", type=int, default=42)
    a = ap.parse_args()

    keras.utils.set_random_seed(a.seed)
    d = np.load(a.data)
    sel = (d["split"] == "train") & (d["W"] > 0)
    X, Y, W = d["X"][sel].astype(np.float32), d["Y"][sel], d["W"][sel]
    rng = np.random.default_rng(a.seed)
    idx = rng.permutation(len(X))
    n_val = int(0.08 * len(X))
    vi, ti = idx[:n_val], idx[n_val:]
    print(f"train {len(ti)}  val {len(vi)}")

    ds = (tf.data.Dataset.from_tensor_slices((X[ti], Y[ti], W[ti]))
          .shuffle(len(ti), seed=a.seed, reshuffle_each_iteration=True)
          .map(augment, num_parallel_calls=tf.data.AUTOTUNE)
          .batch(a.batch).prefetch(tf.data.AUTOTUNE))
    vds = tf.data.Dataset.from_tensor_slices((X[vi], Y[vi], W[vi])).batch(256)

    model = build_model(a.width)
    model.summary(print_fn=lambda s: print(s) if "params" in s.lower() else None)
    steps = a.epochs * int(np.ceil(len(ti) / a.batch))
    sched = keras.optimizers.schedules.CosineDecay(a.lr, steps, warmup_target=None)
    model.compile(optimizer=keras.optimizers.Adam(sched),
                  loss=keras.losses.CategoricalCrossentropy(),
                  metrics=[keras.metrics.CategoricalAccuracy(name="acc")])
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    cb = [keras.callbacks.ModelCheckpoint(a.out, monitor="val_loss", save_best_only=True)]
    t0 = time.time()
    model.fit(ds, validation_data=vds, epochs=a.epochs, callbacks=cb, verbose=2)
    print(f"train time {time.time() - t0:.0f}s, best model -> {a.out}")


if __name__ == "__main__":
    main()
