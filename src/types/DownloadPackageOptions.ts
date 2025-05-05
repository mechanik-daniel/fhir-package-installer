/**
 * © Copyright Outburn Ltd. 2022-2025 All Rights Reserved
 *   Project name: FHIR-Package-Installer
 */

/**
 * Options for the downloadPackage function.
 * @param destination The directory path where the package should be saved or extracted.
 * Defaults to the current working directory.
 * @param overwrite Whether to overwrite the existing package if it already exists.
 * Defaults to false.
 * @param extract Whether to extract the package after downloading.
 * If true, the tarball will be extracted into a subdirectory of `destination`.
 */
export interface DownloadPackageOptions {
    destination?: string,
    overwrite?: boolean,
    extract?: boolean,
  }
  