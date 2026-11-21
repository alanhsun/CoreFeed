/**
 * CoreFeed v3.0 — ESLint v10 Flat Configuration (eslint.config.mjs)
 *
 * Focuses on high-signal runtime correctness & security rules (no formatting bikeshedding),
 * with cleanly separated environments for Node.js CommonJS backend/scripts/tests and
 * native Browser ES Modules under public/js/.
 */

const NODE_GLOBALS = {
    AbortController: 'readonly',
    AbortSignal: 'readonly',
    Blob: 'readonly',
    Buffer: 'readonly',
    FormData: 'readonly',
    Headers: 'readonly',
    Intl: 'readonly',
    Request: 'readonly',
    Response: 'readonly',
    TextDecoder: 'readonly',
    TextEncoder: 'readonly',
    URL: 'readonly',
    URLSearchParams: 'readonly',
    __dirname: 'readonly',
    __filename: 'readonly',
    clearImmediate: 'readonly',
    clearInterval: 'readonly',
    clearTimeout: 'readonly',
    console: 'readonly',
    crypto: 'readonly',
    exports: 'writable',
    fetch: 'readonly',
    global: 'readonly',
    globalThis: 'readonly',
    module: 'readonly',
    process: 'readonly',
    queueMicrotask: 'readonly',
    require: 'readonly',
    setImmediate: 'readonly',
    setInterval: 'readonly',
    setTimeout: 'readonly',
    structuredClone: 'readonly'
};

const BROWSER_GLOBALS = {
    AbortController: 'readonly',
    CSS: 'readonly',
    CustomEvent: 'readonly',
    Element: 'readonly',
    Event: 'readonly',
    HTMLElement: 'readonly',
    IntersectionObserver: 'readonly',
    Intl: 'readonly',
    MediaMetadata: 'readonly',
    MutationObserver: 'readonly',
    Node: 'readonly',
    ResizeObserver: 'readonly',
    URL: 'readonly',
    URLSearchParams: 'readonly',
    cancelAnimationFrame: 'readonly',
    clearInterval: 'readonly',
    clearTimeout: 'readonly',
    console: 'readonly',
    document: 'readonly',
    fetch: 'readonly',
    getComputedStyle: 'readonly',
    history: 'readonly',
    io: 'readonly',
    localStorage: 'readonly',
    location: 'readonly',
    navigator: 'readonly',
    requestAnimationFrame: 'readonly',
    sessionStorage: 'readonly',
    setInterval: 'readonly',
    setTimeout: 'readonly',
    window: 'readonly'
};

const SHARED_RULES = {
    'no-const-assign': 'error',
    'no-constant-condition': ['warn', { checkLoops: false }],
    'no-dupe-args': 'error',
    'no-dupe-keys': 'error',
    'no-duplicate-case': 'error',
    'no-eval': 'error',
    'no-ex-assign': 'error',
    'no-func-assign': 'error',
    'no-implied-eval': 'error',
    'no-import-assign': 'error',
    'no-redeclare': 'error',
    'no-self-assign': 'error',
    'no-undef': 'error',
    'no-unreachable': 'error',
    'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        ignoreRestSiblings: true
    }],
    'use-isnan': 'error',
    'valid-typeof': 'error'
};

export default [
    {
        ignores: [
            'node_modules/**',
            'data/**',
            'logs/**',
            'public/css/**',
            'public/images/**'
        ]
    },
    {
        files: [
            'server.js',
            'config/**/*.js',
            'middleware/**/*.js',
            'routes/**/*.js',
            'services/**/*.js',
            'utils/**/*.js',
            'scripts/**/*.js',
            'tests/**/*.js'
        ],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'commonjs',
            globals: NODE_GLOBALS
        },
        rules: SHARED_RULES
    },
    {
        files: ['eslint.config.mjs'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: NODE_GLOBALS
        },
        rules: SHARED_RULES
    },
    {
        files: ['public/js/**/*.js'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: BROWSER_GLOBALS
        },
        rules: SHARED_RULES
    }
];
