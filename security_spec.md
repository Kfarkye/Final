# Security Spec

## Data Invariants
1. A user can only access their own documents under `/users/{userId}/*`. Scoping is strictly by `userId` in the path.
2. The user profile is created by the user upon signup. Users can only edit `baseModel`.
3. The conversations collection and turns collection are strictly tied to the uid in the path.

## "Dirty Dozen" Payloads
1. User attempts to update a profile not their own.
2. User attempts to specify incorrect model in update.
...

## Test Runner
The `firestore.rules.test.ts` file will use `@firebase/rules-unit-testing` to verify.
