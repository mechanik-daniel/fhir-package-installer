# 🚀 Enhanced FHIR Package Management: Implicit Dependencies & Version Caching

## 📋 Summary

This PR introduces two major enhancements to the FHIR Package Installer:

1. **Implicit Dependency Management** - Automatically includes latest versions of the required terminology and extension packages when installing core FHIR packages
2. **Latest Version Caching** - Prevents HTTP 429 rate limiting errors during bulk operations

The two features are related, since no.1 could not be implemented without triggering the registry rate limit due to repetitive requests for the package's metadata (where the `latest` version is fetched from).

## ✨ Feature 1: Automatic Implicit Dependencies

### Problem
When working with FHIR core packages (`hl7.fhir.r4.core`, `hl7.fhir.r5.core`, etc.), many required terminology assets and extension definitions reside in separate packages expected to be "always in context".
These packages are more frequently updated than the core packages, and the correct version for them *should* always be the latest release.  
See [discussion in FHIR chat](https://chat.fhir.org/#narrow/stream/179239-tooling/topic/New.20Implicit.20Package/near/325318949)

### Solution
Core FHIR packages now automatically include latest version of implicit dependencies:

| Core Package | Automatic Dependencies |
|--------------|----------------------|
| `hl7.fhir.r3.core` | `hl7.terminology.r3`, `hl7.fhir.uv.extensions.r3` |
| `hl7.fhir.r4.core` | `hl7.terminology.r4`, `hl7.fhir.uv.extensions.r4` |
| `hl7.fhir.r5.core` | `hl7.terminology.r5`, `hl7.fhir.uv.extensions.r5` |

FPI will try to resolves latest versions from registry, and fall back to latest available version (from those installed in the package cache) when offline.

## ⚡ Feature 2: Latest Version Caching

### Problem
Bulk FHIR package operations frequently trigger HTTP 429 (Too Many Requests) errors due to repeated registry calls for latest version resolution.

### Solution
Implements caching for latest version lookups in the `checkLatestPackageDist` method to prevent rate limiting during bulk operations.

### New Dependencies
- Added `semver@^7.6.0` for version comparison and sorting
