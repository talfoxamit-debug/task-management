/** @type {import('next').NextConfig} */
export default {
  // The engine and the MCP loader are TypeScript SOURCE in sibling workspaces,
  // not built packages, so Next has to compile them.
  transpilePackages: ['@taskos/engine', '@taskos/mcp'],

  // Those packages use NodeNext resolution, where a TypeScript file imports its
  // sibling as './load.js'. TypeScript maps that back to './load.ts'; bundlers
  // do not, unless told. Without this the build fails on the first such import.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
  turbopack: {
    resolveExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.json'],
  },
};
