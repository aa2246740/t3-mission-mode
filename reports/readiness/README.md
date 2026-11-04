# Readiness reports

`latest.json` and `latest.md` are verbatim copies of local CLI assessment `20261104T033948Z-cf4ee2e74558`, using the versioned `droid-0.240.0` rubric.

The assessment covers source commit `4e7f384511d4a21f9a5059bf5a8d797dbf66deff`. The subsequent archive commit changes only this directory, so `repository.head` identifies the assessed code rather than the commit containing the report itself.

The result is Level 5 at 83.78378378%, with 62 passing criteria, 12 failures and 10 valid skips. The original November 3 assessment remains under its timestamped filenames.

The complete suite passed on frozen Linux ARM64 source in Apple Container with tmpfs fixtures. All 285 source file hashes matched before and after execution. macOS verification covered the HUD, HTTP security, QA, session compatibility and sandbox behavior. The earlier macOS full-suite run was stopped and is not counted as a pass. Native T3 thread-link activation and live provider message delivery were not exercised.
