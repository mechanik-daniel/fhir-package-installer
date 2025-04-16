/**
 * © Copyright Outburn Ltd. 2022-2025 All Rights Reserved
 *   Project name: FHIR-Package-Installer
 */

import { FileInPackageIndex } from './FileInPackageIndex';

/**
 * The structure of a package's `.index.json` and `.fpi.index.json` files, according to version 2 @see https://hl7.org/fhir/packages.html
 */
export interface PackageIndex {
  'index-version': number
  files: FileInPackageIndex[]
}
