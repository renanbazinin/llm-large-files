# Contributing

```bash
npm install
npm run check        # typecheck, tests, build
npm run test:watch
```

- Keep the core (`src/*.ts`) provider-neutral; model-specific code goes under `src/<provider>/`.
- `test/boundary.test.ts` keeps `src/` free of runtime dependencies other than Node built-ins and
  the optional peers `jszip` and `unpdf`. Discuss before adding one.
- Tool names, arguments, and result fields are part of the public API, because models are prompted
  with them. Note changes in `CHANGELOG.md`.
- Add a test for every behavior change. Tests mock `fetch`; they never call a real model.
