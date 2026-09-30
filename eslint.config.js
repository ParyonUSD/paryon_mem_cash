import globals from "globals";
import pluginJs from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
	{ files: ["**/*.{js,mjs,cjs,ts}"] },
	{ languageOptions: { globals: globals.node } },
	pluginJs.configs.recommended,
	...tseslint.configs.recommended,
	{
		rules: {
			"max-len": ["error", { code: 120, ignoreStrings: true, ignoreTemplateLiterals: true }],
			// Upstream marks a handler parameter it must accept but does not read with a leading underscore.
			"@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
		},
	},
	{ ignores: ["dist/"] },
];
