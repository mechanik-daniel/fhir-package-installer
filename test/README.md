# FHIR Package Installer - Dual Mode Testing

This directory contains a comprehensive testing strategy that validates both direct FHIR registry access and JFrog Artifactory proxy scenarios.

## Testing Architecture

### Mock Artifactory Server (`mock-artifactory-server.ts`)
- Simulates JFrog Artifactory behavior including:
  - Bearer token authentication
  - HTTP 302 redirects for tarball downloads
  - npm registry API proxy to an upstream registry (defaults to the public registry, but tests configure a local in-process registry)
  - Proper URL rewriting for mock server references

### Local Registry Server (`local-registry-server.ts`)
- In-process npm-like registry used by tests to avoid outbound network calls
- Serves minimal package metadata (`/<pkg>/`) and tarballs (`/<pkg>/-/<pkg>-<ver>.tgz`)

### Dual Mode Test Runner (`dual-mode-test-runner.ts`)
- Utility that automatically runs tests in both modes:
  - **Direct mode**: Connection directly to a local in-process registry
  - **Artifactory mode**: Connection through mock Artifactory server (which proxies to that same local registry)
- Ensures identical behavior and results across both scenarios

### Test Suites

#### 1. Mock Server Tests (`mock-artifactory-server.test.ts`)
- Validates mock server functionality
- Tests authentication scenarios
- Verifies redirect handling
- Ensures proper proxy behavior

#### 2. Dual Mode Integration Tests (`fhir-package-installer.dual-mode.test.ts`)
- Runs core package installer functionality in both modes
- Tests include:
  - Authentication (valid/invalid tokens)
  - Package installation
  - Metadata retrieval
  - Redirect handling
  - Error scenarios
  - Package indexing

## Running Tests

```bash
# Run only dual-mode tests
npm run test:dual-mode

# Run only mock server tests
npm run test:mock-server

# Run all tests (includes original tests + new dual-mode tests)
npm test

# Default `npm test` includes:
# - a minimal live-registry sanity check against https://packages.fhir.org
# - a live-registry tarball download check (small-ish package)
# - a VSAC indexing regression guard (large real package; reuses cached tarballs/extraction between runs)
# - a synthetic large-package indexing guard (fast/offline) to catch Windows file-handle regressions

# Opt-out if you need a fast/offline run
set FPI_SKIP_LIVE_REGISTRY=1
set FPI_SKIP_VSAC_STRESS=1
set FPI_SKIP_SYNTH_STRESS=1
npm test

# Or use the opt-in light test run (cross-platform)
npm run test:light

# Debugging: keep all VSAC stress-test cache artifacts (including side caches)
set FPI_KEEP_STRESS_CACHE=1
npm test

# Note: for the synthetic stress test, you can tune the size/concurrency:
# set FPI_STRESS_FILE_COUNT=20000
# set FPI_STRESS_WRITE_CONCURRENCY=50
```

## Key Test Scenarios

### 1. Authentication Testing
- ✅ Valid token authentication works
- ✅ Invalid token authentication fails appropriately
- ✅ Direct mode works without authentication

### 2. Redirect Handling
- ✅ Artifactory 302 redirects are followed correctly
- ✅ Authentication headers preserved through redirects
- ✅ Tarball downloads work in both modes

### 3. Behavior Consistency
- ✅ Package metadata identical in both modes
- ✅ Package installation results identical
- ✅ Error handling consistent across modes
- ✅ Generated package indexes identical

## Benefits

1. **Regression Protection**: Locks in current Artifactory behavior
2. **No External Dependencies**: Tests are deterministic/offline and do not require access to public registries
3. **Comprehensive Coverage**: Tests both authentication and redirect scenarios
4. **Future-Proof**: Validates that updates don't break Artifactory integration
5. **Fast Execution**: Local mock server provides quick feedback

## Mock Server Implementation Details

The mock server accurately simulates JFrog Artifactory behavior:

- **Authentication**: Validates Bearer tokens
- **Proxy Logic**: Fetches data from a configurable upstream registry
- **URL Rewriting**: Modifies tarball URLs to point back to mock server
- **Redirect Simulation**: Returns 302 responses for tarball downloads
- **Error Scenarios**: Proper 401/403 responses for auth failures

This approach ensures comprehensive testing without external service dependencies while validating the exact scenarios that caused issues during development.
