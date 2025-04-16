/**
 * © Copyright Outburn Ltd. 2022-2025 All Rights Reserved
 *   Project name: FHIR-Package-Installer
 */

/**
 * The structure of a file entry in the .fpi.index.json file of a package, according to version 2 @see https://hl7.org/fhir/packages.html
 */
export interface FileInPackageIndex {
  filename: string
  resourceType: string
  id: string
  url?: string
  name?: string
  version?: string
  kind?: string
  type?: string
  supplements?: string
  content?: string
  baseDefinition?: string
  derivation?: string
  date?: string
}
