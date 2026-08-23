# FaceRoll Testing

This directory contains the manual system-testing plan and recorded results for FaceRoll.

## Files

- [Test Cases](Test-Cases.md) defines the repeatable checks for the mobile app, instructor dashboard, Firebase integration, and recognition services.
- [Test Results](Test-Results.md) records the environment, tester, date, result, and evidence for each execution.

## Test Procedure

1. Configure Firebase and install the dependencies described in the root `README.md`.
2. Start the component required by the selected test case.
3. Use a dedicated test account and synthetic test data. Do not commit real facial images or embeddings.
4. Follow every step in the selected test case.
5. Record `Pass`, `Fail`, or `Blocked` in `Test-Results.md`.
6. Add concise evidence, such as an issue number, screenshot location, or error summary.
7. Remove test accounts, sessions, attendance records, and local biometric data when testing is complete.

## Result Definitions

- **Pass:** The observed behavior matches every expected result.
- **Fail:** The test completed but at least one expected result was not met.
- **Blocked:** The test could not be completed because a dependency or environment was unavailable.
- **Not Run:** The test has not yet been executed in the documented environment.

