import js from '@eslint/js';

export default [
    { ignores: ['dist/**', 'node_modules/**'] },
    js.configs.recommended,
    {
        files: ['src/**/*.js', 'test/**/*.mjs'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: {
                window: 'readonly',
                document: 'readonly',
                navigator: 'readonly',
                localStorage: 'readonly',
                requestAnimationFrame: 'readonly',
                fetch: 'readonly',
                URL: 'readonly',
                crypto: 'readonly',
                caches: 'readonly',
                Response: 'readonly',
                Request: 'readonly',
                Headers: 'readonly',
                ReadableStream: 'readonly',
                setTimeout: 'readonly',
                clearTimeout: 'readonly',
                console: 'readonly',
                location: 'readonly',
                process: 'readonly',
                Buffer: 'readonly',
            },
        },
        rules: {
            // 降级链路里的 `catch (_) {}` 是刻意的「落到下一档」习惯用法：
            // 空 catch 放行，但被捕获的错误变量不算未使用
            'no-empty': ['error', { allowEmptyCatch: true }],
            'no-unused-vars': ['error', { caughtErrors: 'none' }],
        },
    },
];
