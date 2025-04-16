# FHIR Package Installer

A utility module for downloading, indexing, caching, and managing [FHIR](https://hl7.org/fhir/) packages from the [FHIR Package Registry](https://packages.fhir.org) and [Simplifier](https://simplifier.net/). Commonly used in tooling such as FHIR validators, terminology engines, snapshot generators, and more.

---

## Features

- Download and install FHIR NPM-style packages (e.g., `hl7.fhir.r4.core@4.0.1`)
- Cache downloaded packages locally under `~/.fhir/packages`
- Automatically resolve `latest` versions
- Generate and retrieve a local index (`.fpi.index.json`) of all FHIR JSON files in the package
- Fetch `package.json` manifest and dependencies
- Recursively install required dependencies
- Supports custom logging

---

## Installation

```bash
npm install fhir-package-installer
```

---

## Usage

### Install a FHIR Package
```ts
import { install } from 'fhir-package-installer';

await install('hl7.fhir.r4.core@4.0.1');
```
Supports `name@version`, `name#version`, or just `name` (uses latest).

### Set Custom Logger
```ts
import { setLogger } from 'fhir-package-installer';

setLogger({
  info: msg => console.log('[INFO]', msg),
  warn: msg => console.warn('[WARN]', msg),
  error: msg => console.error('[ERROR]', msg)
});
```
The custom logger will be used by any subsequent calls to any of the module's functions.

### Get Package Directory Path
```ts
import { getPackageDirPath, toPackageObject } from 'fhir-package-installer';

const pkg = await toPackageObject('hl7.fhir.r4.core');
const dir = getPackageDirPath(pkg);
```

### Access Package Manifest
```ts
import { getManifest } from 'fhir-package-installer';

const manifest = await getManifest({ id: 'hl7.fhir.r4.core', version: '4.0.1' });
```

### Access Package Index
```ts
import { getPackageIndexFile } from 'fhir-package-installer';

const index = await getPackageIndexFile({ id: 'hl7.fhir.r4.core', version: '4.0.1' });
```

---

## Cache Location
Packages are cached to:
```bash
~/.fhir/packages/<name>#<version>
```

---

## Index Format: `.fpi.index.json`
Each package gets a generated index of its FHIR JSON files:
```json
{
  "index-version": 2,
  "files": [
    {
      "filename": "StructureDefinition-something.json",
      "resourceType": "StructureDefinition",
      "id": "something",
      "url": "http://...",
      "kind": "resource", // StructureDefinition resources only
      "name": "Something",
      "version": "1.0.0",
      "type": "Observation",
      "supplements": "http://...", // CodeSystem resources only
      "content": "complete", // CodeSystem resources only
      "baseDefinition": "http://...", // StructureDefinition resources only
      "derivation": "constraint", // StructureDefinition resources only
      "date": "2020-01-01"
    }
  ]
}
```

The attributes are populated from the corresponding attribute in the resource JSON file. If an attribute does not exist in the resource, it will be missing from the index.  
*Note:* This index file is simillar, but not identical, to the official `.package.index` defined in the FHIR Package NPM specification. the `.fpi.index.json` has extra attributes defined so tools can fetch important information missing from the official spec without needing to read and parse the whole resource content.

---

## License
MIT  
© Outburn Ltd. 2022–2025. All Rights Reserved.

---

## Disclaimer
This project is part of the [FUME](https://github.com/Outburn-IL/fume-community) open-source initiative and intended for use in FHIR tooling and development environments.

