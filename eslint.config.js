// @ts-check
import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [
  {
    ignores: ["dist/**", "node_modules/**", ".worktrees/**", "coverage/**"],
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        sourceType: "module",
        ecmaVersion: "latest",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-restricted-syntax": [
        "error",
        {
          // Forbid raw SQL string concatenation patterns outside the database-mysql plugin's
          // own low-level driver wiring — everyone else must use the query builder / capability.
          selector:
            "CallExpression[callee.property.name='query'] TemplateLiteral[expressions.length>0]",
          message:
            "Do not interpolate values into SQL template literals. Use kysely query builder or parameterized queries via the database-mysql capability.",
        },
      ],
    },
  },
];
