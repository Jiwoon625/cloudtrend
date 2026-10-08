# Lite r3 daily runtime

Daily collector stages used by a small, private Colab notebook. The notebook pins both the repository commit and the SHA-256 of `runtime.zip`; the ZIP contains the `cloudtrend_lite_r3_runtime` Python package.

- Import has no collection or network side effects. Run `STAGES` sequentially with `run_stage(name, notebook_globals)`.
- Account destinations, owner identity, Drive paths and credentials are supplied by the notebook or existing Colab Secrets, not embedded in this package.
- Existing KR publishing and post-upload screening requests are retained. US collection keeps the 400-bar cache and 15-bar incremental request policy.
- US daily inputs are preserved before upload. Automatic catch-up accepts only original dated atomic inputs. Historical reconstruction tooling is deliberately excluded.
- Partial uploads do not trigger screening. Request journals suppress duplicate or uncertain dispatches. An unfinished catch-up blocks advancing ingest until its publication receipt is complete.
- `runtime.zip` is a versioned release artifact, not a mutable dependency. Changes require rebuilding it and updating the notebook's commit and hash together.

The thin notebook reduces notebook source and saved-output size. No measured Colab opening-time or peak-memory improvement is claimed.
