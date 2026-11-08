# Read-only display continuity after November 6 index verification

The November 8 index-reference rollout preserved saved results but advanced the
live cache revision. This made the latest dashboard reject the prior saved
calculation, even though all three verified constituent lists were unchanged.
Historical run pages remained readable. No missing-cache state means deletion.

This repair is narrowly limited to the dashboard's read path. It may project the
exact prior `screening-cache-v9-current-price-20261104-v1` result only while the
current target is `screening-cache-v9-current-price-verified-kr-index-20261106-v1`.
It verifies the expected three snapshot dates and exact October 30/November 6
constituent equality, current sources/configuration/operational-index identity
under the original cache version, and the full saved result digest. Any present
Drive input head, unsupported version or mismatch fails closed.

The original calculation date, timestamp, source fingerprint and result digest
remain unchanged. The UI identifies an older stored result, links to historical
details, and does not infer a new index provenance date from the analysis date.
Current-action panels are unavailable in this display-only mode. The strict
screening cache reader remains unchanged in eligibility: old results are not
accepted as current screening or order-action evidence.

This branch never repairs or uploads the compatibility projection, reruns the
engine, writes signal history, modifies ledgers or changes source registration.
The normal validated-current-cache path retains its existing behavior. Future
reference or cache revisions do not inherit this narrowly reviewed exception.
