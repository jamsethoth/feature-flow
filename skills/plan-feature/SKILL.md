---
name: plan-feature
description: Plan a new feature with feature-flow - grill the user, slice it into vertical-slice GitHub tickets with definitions of done and dependencies, and publish them. Use when the user wants to plan or start new feature work with feature-flow.
---

1. Run `ff persona planner` and follow the persona it prints for the rest of this conversation.
2. Run `ff config` and note `plan` (the configured planning model/effort) and `planApproval`.
   If you are not running on the configured planning model, warn the user once (suggest starting
   with `ff plan` instead) and carry on.
3. If `ff` is not installed, tell the user to run `npm install -g github:jamsethoth/feature-flow`.
