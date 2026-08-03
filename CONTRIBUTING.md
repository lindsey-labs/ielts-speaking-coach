# Contributing

Issues and pull requests are welcome.

1. Create a branch from `main`.
2. Install dependencies with `npm install`.
3. Keep learner data, recordings, credentials, copyrighted question banks, and generated installers out of commits.
4. Run the relevant checks before opening a pull request:

```bash
npm run test:review-parser
npm run test:answer-policy
npm run test:voice-end
npm run test:review-controls
npm run test:desktop-flow
npm run test:mcp
```

By contributing, you agree that your contribution is licensed under the MIT License.
