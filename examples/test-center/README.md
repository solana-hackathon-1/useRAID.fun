# Test center consuming host

Consumes the v1 `TestCenter` component directly, without Next.js or an app/database singleton.
Dependencies and JSX configuration are declared locally. Canonical source symlinks keep one implementation.

For an independent installed copy, copy this directory with symlinks dereferenced (`cp -RL`),
then install its dependencies and run `npm start`. No environment variables or database are required.
The host renders the real component, checks its read-only mode and confirms no fixture-login action exists.
Browser interaction, mobile layout and exact amount rejection are verified by the repository's browser suite.

The composing host supplies styles, routing and any optional `children` actions. `sandbox` is a
presentation prop, never authorization. The RAID page checks the server's sandbox policy, and existing
sandbox APIs recheck it independently. See [the feature contract](../../docs/raid-test-center.md).
