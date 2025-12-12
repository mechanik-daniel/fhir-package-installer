# FHIR Package Installer

A utility module for downloading, indexing, caching, and managing [FHIR](https://hl7.org/fhir/) packages from the [FHIR Package Registry](https://packages.fhir.org) and [Simplifier](https://simplifier.net/). Commonly used in tooling such as FHIR validators, terminology engines, snapshot generators, and more.

---

## Features

- Download and install [FHIR NPM-style packages](https://hl7.org/fhir/packages.html) (e.g., `hl7.fhir.uv.sdc@3.0.0`)
- Cache downloaded packages locally in the [FHIR Package Cache](https://confluence.hl7.org/spaces/FHIR/pages/66928417/FHIR+Package+Cache) or a custom path if defined in the constructor.
- Automatically resolve `latest` versions
- **Automatic implicit dependencies** - Core FHIR packages automatically include terminology and extension packages
- Generate and retrieve a local index (`.fpi.index.json`) of all FHIR JSON files in the package
- Fetch `package.json` manifest and dependencies
- Recursively install required dependencies
- Support for private registries including JFrog Artifactory, Nexus, and Azure DevOps
- Built-in latest version caching for FHIR packages to prevent HTTP 429 rate limiting during bulk operations
- Customizable registry URL, logger, and cache location

---

## Installation

```bash
npm install fhir-package-installer
```

---

## Quick Start (Default Usage)

```ts
import fpi from 'fhir-package-installer';

await fpi.install('hl7.fhir.r4.core@4.0.1');

const index = await fpi.getPackageIndexFile({ id: 'hl7.fhir.r4.core', version: '4.0.1' });
```

---

## Dual Module Usage (ESM & CommonJS)

Starting with version 1.4.1, this package ships a dual build that supports both ESM and CommonJS consumers without the `ERR_REQUIRE_ESM` error.

### ESM (Node >= 18 with "type": "module" or .mjs)

```js
import { FhirPackageInstaller } from 'fhir-package-installer';

const fpiClassInstance = new FhirPackageInstaller();
await fpiClassInstance.install('hl7.fhir.r4.core@4.0.1');
```

### CommonJS (legacy .cjs / no "type": "module")

```js
const { FhirPackageInstaller } = require('fhir-package-installer');

const fpiClassInstance = new FhirPackageInstaller();
fpiClassInstance.install('hl7.fhir.r4.core@4.0.1').then(() => console.log('Installed'));
```

### Default Instance Export

For convenience, a default instance (`fpi`) is still exported:

```js
import fpi from 'fhir-package-installer'; // ESM
// or
const fpi = require('fhir-package-installer').default; // CJS
```

### TypeScript Consumers

Type declarations resolve automatically via the `exports` map:

```ts
import { FhirPackageInstaller, PackageIdentifier } from 'fhir-package-installer';
```

No additional `types` configuration is required.

---

---

## Advanced Usage (Custom Configurations)

Use the `FhirPackageInstaller` class directly to customize behavior:

```ts
import { FhirPackageInstaller } from 'fhir-package-installer';

const customFpi = new FhirPackageInstaller({
  logger: {
    info: msg => console.log('[INFO]', msg),
    warn: msg => console.warn('[WARN]', msg),
    error: msg => console.error('[ERROR]', msg)
  },
  registryUrl: 'https://packages.fhir.org',
  registryToken: 'your-registry-token-here', // For private registries / artifactories
  cachePath: './my-fhir-cache'
});

await customFpi.install('hl7.fhir.r4.core');
```

### `FpiConfig` fields:
- `logger` – Optional. Custom logger implementing the `ILogger` interface (from `@outburn/types`).
- `registryUrl` – Optional. Custom package registry base URL (e.g., JFrog Artifactory).
- `registryToken` – Optional. Authentication token for private registries.
- `cachePath` – Optional. Directory where packages will be cached.
- `skipExamples` – Optional. Don't install dependencies that have `examples` in the package name
- `latestVersionCache` – Optional. Custom latest version cache implementing `ILatestVersionCache` (default: in-memory cache with 5-minute TTL)

---

## Public API Methods

### `install(packageId: string | PackageIdentifier): Promise<boolean>`
Downloads and installs a package and all its dependencies.  
Accepts either a package identifier object (`{ id, version }` from `@outburn/types`) or a string (`'name@version'`, `'name#version'`, or `'name'`).

---

### `downloadPackage(packageId: string | PackageIdentifier, options?: DownloadPackageOptions): Promise<string>`
Downloads a package tarball and optionally extracts it to a destination directory.

---

### `installLocalPackage(src: string, options?: InstallPackageOptions): Promise<boolean>`
Installs a package from a local file or directory.  
The package can be a tarball file or a directory containing the package files.  

---

### `getManifest(packageId: string | PackageIdentifier): Promise<PackageManifest>`
Fetches the `package.json` manifest of an installed package.

---

### `getPackageIndexFile(packageId: string | PackageIdentifier): Promise<PackageIndex>`
Returns the `.fpi.index.json` content for the package.  
If the file doesn't exist, it will be generated automatically.

---

### `getDependencies(packageId: string | PackageIdentifier): Promise<Record<string, string>>`
Returns the direct dependencies of a package, including both explicit dependencies defined in `package.json` and automatic implicit dependencies (for core FHIR packages).

---

### `checkLatestPackageDist(packageName: string): Promise<string>`
Looks up the latest published version for a given package name (string only).

---

### `toPackageObject(packageId: string | PackageIdentifier): Promise<PackageIdentifier>`
Parses `name`, `name@version`, or `name#version` into an object with `id` and `version`.  
If no version is provided, resolves to the latest.

---

### `isInstalled(packageId: string | PackageIdentifier): Promise<boolean>`
Returns `true` if the package is already present in the local cache.

---

### `getCachePath(): string`
Returns the root cache directory used by this installer.

---

### `getLogger(): ILogger`
Returns the logger instance used by this installer.

---

### `getPackageDirPath(packageId: string | PackageIdentifier): Promise<string>`
Returns the path to a specific package folder in the cache.

---

## Implicit Dependency Management

FHIR Package Installer automatically manages implicit dependencies for core FHIR packages. When you install a base FHIR package (like `hl7.fhir.r4.core`), the system automatically includes essential terminology and extension packages that are commonly required.

### Automatic Implicit Dependencies

When installing core FHIR packages, these implicit dependencies are automatically added:

| Core Package | Implicit Dependencies |
|--------------|----------------------|
| `hl7.fhir.r3.core` | `hl7.terminology.r3`, `hl7.fhir.uv.extensions.r3` |
| `hl7.fhir.r4.core` | `hl7.terminology.r4`, `hl7.fhir.uv.extensions.r4` |
| `hl7.fhir.r5.core` | `hl7.terminology.r5`, `hl7.fhir.uv.extensions.r5` |

### Fallback Behavior

The implicit dependency resolver uses an **online-first, cache-fallback** strategy:

1. **Online Resolution**: Attempts to resolve the latest versions from the registry
2. **Cache Fallback**: If online resolution fails, uses the latest cached versions
3. **Graceful Degradation**: Logs warnings but continues installation if implicit packages can't be resolved


---

## FHIR Package Latest Version Caching

To prevent HTTP 429 rate limiting errors when installing multiple FHIR packages or resolving many "latest" versions, FHIR Package Installer includes built-in latest version caching:

### Default Behavior
- **Automatic caching**: Latest versions of FHIR packages are cached in memory with a 5-minute TTL
- **Shared instances**: Multiple `FhirPackageInstaller` instances can share the same cache
- **Rate limit prevention**: Reduces registry calls by ~60-80% in typical workflows

## FHIR Package Cache Directory

### Location

Location of the default global package cache differs per operating system.

Windows: 
```
c:\users\<username>\.fhir\packages
```

Unix/Linux: 
```
/~/.fhir/packages
```

### For system services (daemons):

Windows: 
```
C:\Windows\System32\config\systemprofile\.fhir\packages
```
Unix/Linux: 
```
/var/lib/.fhir/packages
```  

### Folder Structure
The package cache root folder contains a folder per package where the folder name is the package name, a pound and the package version:

- `package-cache-folder`
  - `hl7.fhir.us.core#0.1.1`
  - `hl7.fhir.r4.core#4.0.1`
  - `hl7.fhir.uv.sdc#3.0.0`

---

## JFrog Artifactory & Private Registry Support

FHIR Package Installer supports JFrog Artifactory and other private NPM registries that act as secure proxies or mirrors of the public FHIR Package Registry. Artifactory is commonly used by enterprises to provide cached, controlled access to FHIR packages through their internal infrastructure, along with other solutions like Nexus Repository and Azure DevOps Artifacts.

### Artifactory Configuration

```ts
import { FhirPackageInstaller } from 'fhir-package-installer';

const artifactoryFpi = new FhirPackageInstaller({
  registryUrl: 'https://your-artifactory.example.com/artifactory/api/npm/fhir-npm-remote',
  registryToken: 'cmVmdGtuOjAxOjE3ODQ5Nzc0OTI6NU83WE9JTkFrOVJtVWxxSmpzcXZsYWVaeHpL', // Do not include 'Bearer' prefix
  cachePath: './custom-cache'
});

// Install public FHIR packages through your Artifactory registry
await artifactoryFpi.install('hl7.fhir.r4.core@4.0.1');
await artifactoryFpi.install('hl7.fhir.us.core@6.1.0');
```

### JFrog Artifactory Setup Requirements

⚠️ **Critical Configuration**: When setting up your JFrog Artifactory repository for FHIR packages, you must:

1. **Repository Type**: Create an **npm** remote repository (not generic)
2. **Remote URL**: Set to `https://packages.simplifier.net`
   - ⚠️ Use Simplifier URL, not `packages.fhir.org` (which is just an alias)
   - The actual package metadata and tarball URLs always reference Simplifier
3. in **Advanced Settings**: ✅ **Check "Bypass HEAD Request"** option
   - This is essential because the FHIR Package Registry doesn't fully comply with npm protocol expectations
   - Without this setting, package installation will fail

**Why this matters**: The FHIR Package Registry behaves differently from standard npm registries. The "Bypass HEAD Request" option tells Artifactory to skip certain npm protocol checks that would otherwise cause failures when proxying FHIR packages.

### Supported Private Registry Solutions

- **JFrog Artifactory**: npm remote repositories (most common enterprise solution)
- **Sonatype Nexus**: npm proxy repositories  
- **Azure DevOps Artifacts**: npm feeds
- **GitHub Packages**: npm package registry
- **Custom npm registries**: Any npm-compatible registry with Bearer token authentication

---

## Index Format: `.fpi.index.json`

Each installed package is scanned for JSON files in the `package/` subdirectory (excluding `package.json` and any `[*].index.json` files). A generated index is written to:
```bash
<packagePath>/package/.fpi.index.json
```

Sample structure:
```json
{
  "index-version": 2,
  "files": [
    {
      "filename": "StructureDefinition-something.json",
      "resourceType": "StructureDefinition",
      "id": "something",
      "url": "http://...",
      "kind": "resource",
      "name": "Something",
      "version": "1.0.0",
      "type": "Observation",
      "supplements": "http://...",
      "content": "complete",
      "baseDefinition": "http://...",
      "derivation": "constraint",
      "date": "2020-01-01"
    }
  ]
}
```

**Notes:**
- All fields are optional and, with the exception of `filename`, populated directly from the original JSON resource.
- This index is an enhanced alternative to the [`.index.json`](https://hl7.org/fhir/packages.html#2.1.10.4) format in the FHIR NPM spec.
- Intended to optimize access to key metadata for tools like validators and template generators.

---

## License
MIT  
© Outburn Ltd. 2022–2025. All Rights Reserved.

---

## Disclaimer
This project is part of the [FUME](https://github.com/Outburn-IL/fume-community) open-source initiative and intended for use in FHIR tooling and development environments.

