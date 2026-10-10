# Lite r3 daily runtime

Daily collector stages used by a small, private Colab notebook. The notebook pins both the repository commit and the SHA-256 of `runtime.zip`; the ZIP contains the `cloudtrend_lite_r3_runtime` Python package.

- Import has no collection or network side effects. Run `STAGES` sequentially with `run_stage(name, notebook_globals)`.
- Account destinations, owner identity, Drive paths and credentials are supplied by the notebook or existing Colab Secrets, not embedded in this package.
- Existing KR publishing and post-upload screening requests are retained. US collection keeps the 400-bar cache and 15-bar incremental request policy.
- US daily inputs are preserved before upload. Automatic catch-up accepts only original dated atomic inputs. Historical reconstruction tooling is deliberately excluded.
- Partial uploads do not trigger screening. Request journals suppress duplicate or uncertain dispatches. An unfinished catch-up blocks advancing ingest until its publication receipt is complete.
- `runtime.zip` is a versioned release artifact, not a mutable dependency. Changes require rebuilding it and updating the notebook's commit and hash together.

The thin notebook reduces notebook source and saved-output size. No measured Colab opening-time or peak-memory improvement is claimed.

## Latest-price-unconfirmed policy (Lite r4 daily v2)

A successful candle response with no positive confirmed-session bar is held as
`latest_price_unconfirmed`, including gaps longer than seven calendar days.
The cache/provider last-bar dates, confirmed session, gap length and error are
recorded separately in dated collection evidence and upload metadata. No
suspension or corporate action is inferred, and no current bar is synthesized.
Held rows carry no executable prices or scores; source coverage remains false.

The existing aggregate limit of 10 symbols is retained across short, long and
empty incremental responses with valid prior cached prices. Missing cached
evidence still blocks upload. SPY is never exempt.
Authentication, HTTP, network, malformed-response and other unexpected failures
remain fatal, including for guarded corporate-action candidates. Rejected
checkpoint bytes are preserved by content hash before retrying. Healthy current
cache rows/checkpoints are reused on same-session reruns.

Build and verify the release with:

```sh
python collectors/lite_r3/build_release.py
python collectors/lite_r3/test_runtime.py
```

Tests require pandas, numpy and pyarrow. The import/package path remains
`cloudtrend_lite_r3_runtime` for existing thin notebooks. Updating source or main
alone cannot update a pinned notebook: replace both its `_RUNTIME_COMMIT` and
`_RUNTIME_SHA256` only after the exact commit is available, preserving the
original notebook and all unrelated cells/settings/outputs.

This policy does not relax original-atomic-input, replay, immutable-source,
upload-readback or screening-dispatch guards. A historical session without a
saved atomic input still requires separate evidence-backed recovery review.
