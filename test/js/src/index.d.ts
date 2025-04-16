/**
 * © Copyright Outburn Ltd. 2022-2025 All Rights Reserved
 *   Project name: FHIR-Package-Installer
 */
import { PackageIdentifier } from './types/PackageIdentifier';
import { PackageIndex } from './types/PackageIndex';
import { PackageManifest } from './types/PackageManifest';
import { ILogger } from './types/Logger';
/**
 * Sets a custom logger to be used instead of the default logger.
 * @param logger custom logger to be used
 */
export declare const setLogger: (logger?: ILogger) => void;
/**
 * Get the path to the FHIR package cache directory.
 * This directory is used to store downloaded and extracted FHIR packages.
 * If the directory does not exist, it will be created.
 * @throws {Error} If the directory cannot be created
 * @returns {string} The path to the FHIR package cache directory
 */
export declare const getCachePath: () => string;
/**
 * Takes a PackageIdentifier Object and returns the path to the package folder in the cache
 * @param packageObject A PackageIdentifier Object with both name and version keys
 * @returns
 */
export declare const getPackageDirPath: (packageObject: PackageIdentifier) => string;
/**
 * Fetches the package index file from the package folder.
 * If the file does not exist, it will be generated and returned.
 * @param packageObject A PackageIdentifier Object with both name and version keys
 * @returns The content of the index file as a PackageIndex object
 */
export declare const getPackageIndexFile: (packageObject: PackageIdentifier) => Promise<PackageIndex>;
/**
 * Checks if the package folder is found in the package cache
 * @param packageObject An object with `name` and `version` keys
 * @returns `true` if the package folder was found, `false` otherwise
 */
export declare const isInstalled: (packageObject: PackageIdentifier) => boolean;
/**
 * Checks the package registry for the latest published version of a package
 * @param packageName (string) The package id alone, without the version part
 * @returns The latest published version of the package
 */
export declare const checkLatestPackageDist: (packageName: string) => Promise<string>;
/**
 * Parses a package identifier string into a PackageObject.
 * If the version was not supplied it will be resolved to the latest published version
 * @param packageId (string) Raw package identifier string. Could be `name@version`, `name#version` or just `name`
 * @returns a PackageObject with name and version
 */
export declare const toPackageObject: (packageId: string) => Promise<PackageIdentifier>;
/**
 * Fetch the manifest (package.json) file from the package folder.
 * @param packageObject A PackageIdentifier Object with both name and version keys
 * @returns The content of the package manifest as a PackageManifest object
 */
export declare const getManifest: (packageObject: PackageIdentifier) => Promise<PackageManifest>;
/**
 * Get a package's dependencies from the package manifest
 * @param packageObject A PackageIdentifier Object with both name and version keys
 * @returns The dependencies array from the package manifest
 */
export declare const getDependencies: (packageObject: PackageIdentifier) => Promise<{
    [key: string]: string;
} | undefined>;
/**
 * Ensures that a package and all of its dependencies are installed in the global package cache.
 * If a version is not supplied, the latest release will be looked up and installed.
 * @param packageId string in the format packageId@version | packageId | packageId#version
 */
export declare const install: (packageId: string | PackageIdentifier, logger?: ILogger) => Promise<boolean>;
//# sourceMappingURL=index.d.ts.map