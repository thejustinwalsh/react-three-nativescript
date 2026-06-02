// Flat config (ESLint 10). The point of having a linter here at all is the rules-of-react: with the
// React Compiler turned on in the apps, code that breaks React's rules silently de-opts the compiler
// instead of erroring. eslint-plugin-react-hooks v7 ships those checks (purity, immutability, refs,
// set-state-in-render, manual-memo preservation, ...) in its recommended-latest preset, so the same
// rules the compiler enforces at build time are caught in the editor first.
//
// Prettier owns formatting; eslint-config-prettier (last) switches off every stylistic rule so the two
// don't fight. tseslint.config() flattens the `extends` arrays and pushes each block's `files` down onto
// the configs it extends, so the react/ts rules only ever hit real source.
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/platforms/**', '**/hooks/**', '**/node_modules/**', '**/*.d.ts'],
  },
  // React/TS source. tseslint.configs.recommended turns off the core rules it replaces (no-undef,
  // no-unused-vars) since the type system already covers them; recommended-latest is the freshest
  // rules-of-react set that mirrors the compiler.
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommended, reactHooks.configs.flat['recommended-latest']],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // three.js / r3f interop is structurally untyped at the seams (raw scene graph traversal, the
      // props splat on <primitive>, the error object handed to onError). `any` there is deliberate and
      // already accepted, so flagging every one is noise, not signal — off. The linter is here for the
      // rules of react, which still error.
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  // Build glue: the webpack preset and the worker loader are CommonJS running in Node.
  {
    files: ['**/*.{js,cjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },
  // Test + setup code legitimately reaches for things app/library source shouldn't: require() to pull
  // in the CJS loader, @ts-ignore to stub globals (where @ts-expect-error is fragile — it errors if the
  // next line happens to be clean), short-circuit mock calls, and any-typed fakes.
  {
    files: ['**/*.test.{ts,tsx}', '**/tests/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  prettier,
)
