/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * © Copyright Outburn Ltd. 2022-2025 All Rights Reserved
 *   Project name: FHIR-Package-Installer
 */

import https from 'https';
import fs from 'fs-extra';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import * as tar from 'tar';
import temp from 'temp';
import os from 'os';

import { FileInPackageIndex } from './types/FileInPackageIndex';
import { PackageIdentifier } from './types/PackageIdentifier';
import { PackageIndex } from './types/PackageIndex';
import { PackageManifest } from './types/PackageManifest';
import { PackageResource } from './types/PackageResource';
import { ILogger } from './types/Logger';

/**
 * default logger uses console.log 
 * */
const defaultLogger: ILogger = {
  info: (msg: any) => console.log(msg),
  warn: (msg: any) => console.warn(msg),
  error: (msg: any) => console.error(msg)
};

/**
 *  this will contain the custom logger, if provided 
 * */
let customLogger: ILogger | undefined = undefined;

/**
 * Sets a custom logger to be used instead of the default logger.
 * @param logger custom logger to be used
 */
export const setLogger = (logger?: ILogger) => {
  customLogger = logger ?? undefined;
};

/**
 * Get the current logger. If a custom logger was set, it will be used.
 * Otherwise, the default logger will be used.
 * @returns {ILogger} The current logger
 */
const getLogger = (): ILogger => {
  if (customLogger) return customLogger;
  return defaultLogger;
};

/**
 * Get the path to the FHIR package cache directory.
 * This directory is used to store downloaded and extracted FHIR packages.
 * If the directory does not exist, it will be created.
 * @throws {Error} If the directory cannot be created
 * @returns {string} The path to the FHIR package cache directory
 */
export const getCachePath = () => {
  const cachePath = path.join(os.homedir(), '.fhir', 'packages');
  if (!fs.existsSync(cachePath)) {
    fs.mkdirSync(cachePath, { recursive: true });
    getLogger().info(`Directory '${cachePath}' created successfully.`);
  }
  return cachePath;
};

// The URL of the FHIR package registry
const registryUrl = 'https://packages.fhir.org';
const fallbackTarballUrl = (packageObject: PackageIdentifier) => `https://packages.simplifier.net/${packageObject.id}/-/${packageObject.id}-${packageObject.version}.tgz`;

/**
 * Takes a PackageIdentifier Object and returns the corresponding directory name of the package
 * @param packageObject A PackageObject with both name and version keys
 * @returns (string) Directory name in the standard format `name#version`
 */
const toDirName = (packageObject: PackageIdentifier): string => packageObject.id + '#' + packageObject.version;

/**
 * Takes a PackageIdentifier Object and returns the path to the package folder in the cache
 * @param packageObject A PackageIdentifier Object with both name and version keys
 * @returns 
 */
export const getPackageDirPath = (packageObject: PackageIdentifier): string => {
  const dirName = toDirName(packageObject);
  const packPath = path.join(getCachePath(), dirName);
  return packPath;
};

/**
 * Get the full path to the .fpi.index.json file in the package folder
 * @param packageObject A PackageIdentifier Object with both name and version keys
 * @returns (string) The path to the package index file
 */
const getPackageIndexPath = (packageObject: PackageIdentifier): string => path.join(getPackageDirPath(packageObject), 'package', '.fpi.index.json');

/**
 * Scans a package folder and generates a new `.fpi.index.json` file
 * @param packagePath The path where the package is installed
 * @returns PackageIndex
 */
const generatePackageIndex = async (packageObject: PackageIdentifier): Promise<PackageIndex> => {
  getLogger().info(`Generating new .fpi.index.json file for package ${packageObject.id}@${packageObject.version}...`);
  const packagePath = getPackageDirPath(packageObject);
  const indexPath = getPackageIndexPath(packageObject);
  const evalAttribute = (att: any | any[]) => (typeof att === 'string' ? att : undefined);
  try {
    const fileList = await fs.readdir(path.join(packagePath, 'package'));
    const files = await Promise.all(
      fileList.filter(
        file => file.endsWith('.json') && file !== 'package.json' && !file.endsWith('.index.json')
      ).map(
        async (file: string) => {
          const content: PackageResource = JSON.parse(await fs.readFile(path.join(packagePath, 'package', file), { encoding: 'utf8' }));
          const indexEntry: FileInPackageIndex = {
            filename: file,
            resourceType: content.resourceType,
            id: content.id,
            url: evalAttribute(content.url),
            name: evalAttribute(content.name),
            version: evalAttribute(content.version),
            kind: evalAttribute(content.kind),
            type: evalAttribute(content.type),
            supplements: evalAttribute(content.supplements),
            content: evalAttribute(content.content),
            baseDefinition: evalAttribute(content.baseDefinition),
            derivation: evalAttribute(content.derivation),
            date: evalAttribute(content.date)
          };
          return indexEntry;
        }
      )
    );
    const indexJson: PackageIndex = {
      'index-version': 2,
      files
    };
    await fs.writeFile(indexPath, JSON.stringify(indexJson, null, 2));
    return indexJson;
  } catch (e) {
    getLogger().error(e);
    throw (e);
  };
};

/**
 * Fetches the package index file from the package folder.
 * If the file does not exist, it will be generated and returned.
 * @param packageObject A PackageIdentifier Object with both name and version keys
 * @returns The content of the index file as a PackageIndex object
 */
export const getPackageIndexFile = async (packageObject: PackageIdentifier): Promise<PackageIndex> => {
  const path = getPackageIndexPath(packageObject);
  if (await fs.exists(path)) {
    const contents: string = await fs.readFile(path, { encoding: 'utf8' });
    const parsed: PackageIndex = JSON.parse(contents);
    return parsed;
  };
  /* If we got here it means the index file is missing */
  /* Hence, we need to build it */
  const newIndex: PackageIndex = await generatePackageIndex(packageObject);
  return newIndex;
};

/**
 * Checks if the package folder is found in the package cache
 * @param packageObject An object with `name` and `version` keys
 * @returns `true` if the package folder was found, `false` otherwise
 */
export const isInstalled = (packageObject: PackageIdentifier): boolean => {
  const packPath = getPackageDirPath(packageObject);
  return fs.existsSync(packPath);
};

/**
 * Extracts the version of the package
 * @param packageId (string) Raw package identifier string. Could be `name@version`, `name#version` or just `name`
 * @returns The version part of the package identifier. If not supplied, `latest` will be returned
 */
const getVersionFromPackageString = (packageId: string): string => {
  const byPound = packageId.split('#');
  const byAt = packageId.split('@');
  if (byPound.length === 2) return byPound[1];
  if (byAt.length === 2) return byAt[1];
  return 'latest';
};

/**
 * Queries the registry for the package information
 * @param packageName Only the package name (no version)
 * @returns The response object from the registry
 */
function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse JSON from ${url}: ${e}`));
        }
      });
    }).on('error', reject);
  });
}

/**
 * Fetches a readable stream from a given URL
 * Used to stream tarball downloads
 * @param url The URL to fetch
 * @returns Readable stream
 */
function fetchStream(url: string): Promise<Readable> {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode === 200) {
        resolve(res);
      } else {
        reject(new Error(`Failed to fetch ${url} (status ${res.statusCode})`));
      }
    }).on('error', reject);
  });
}

const getPackageDataFromRegistry = async (packageName: string): Promise<Record<string, any | any[]>> => {
  return await fetchJson(`${registryUrl}/${packageName}/`);
};

/**
 * Checks the package registry for the latest published version of a package
 * @param packageName (string) The package id alone, without the version part
 * @returns The latest published version of the package
 */
export const checkLatestPackageDist = async (packageName: string): Promise<string> => {
  const packageData = await getPackageDataFromRegistry(packageName);
  const latest = packageData['dist-tags']?.latest;
  return latest;
};

/**
 * Parses a package identifier string into a PackageObject.
 * If the version was not supplied it will be resolved to the latest published version
 * @param packageId (string) Raw package identifier string. Could be `name@version`, `name#version` or just `name`
 * @returns a PackageObject with name and version
 */
export const toPackageObject = async (packageId: string): Promise<PackageIdentifier> => {
  const packageName: string = packageId.split('#')[0].split('@')[0];
  let packageVersion: string = getVersionFromPackageString(packageId);
  if (packageVersion === 'latest') packageVersion = await checkLatestPackageDist(packageName);
  return { id: packageName, version: packageVersion };
};

/**
 * Resolve a package object into a URL for the package tarball
 * @param packageObject
 * @returns Tarball URL
 */
const getTarballUrl = async (packageObject: PackageIdentifier): Promise<string> => {
  let tarballUrl: string;
  try {
    const packageData = await getPackageDataFromRegistry(packageObject.id);
    const versionData = packageData.versions[packageObject.version];
    tarballUrl = versionData?.dist?.tarball;
  } catch {
    tarballUrl = fallbackTarballUrl(packageObject);
  };
  return tarballUrl;
};

/**
 * Move an extracted package content from temporary directory into the FHIR package cache
 * @param packageObject
 * @param tempDirectory
 * @returns The final path of the package in the cache
 */
const cachePackageTarball = async (packageObject: PackageIdentifier, tempDirectory: string): Promise<string> => {
  const finalPath = path.join(getCachePath(), toDirName(packageObject));
  if (!isInstalled(packageObject)) {
    await fs.move(tempDirectory, finalPath);
    getLogger().info(`Installed ${packageObject.id}@${packageObject.version} in the FHIR package cache: ${finalPath}`);
  }
  return finalPath;
};

const downloadTarball = async (packageObject: PackageIdentifier): Promise<string> => {
  const tarballUrl: string = await getTarballUrl(packageObject);
  const tarballStream = await fetchStream(tarballUrl);
  try {
    temp.track();
    const tempDirectory = temp.mkdirSync();
    await pipeline(tarballStream, tar.x({ cwd: tempDirectory }));
    getLogger().info(`Downloaded ${packageObject.id}@${packageObject.version} to a temporary directory`);
    return tempDirectory;
  } catch (e) {
    getLogger().error(`Failed to extract tarball of package ${packageObject.id}@${packageObject.version}`);
    throw e;
  }
};

/**
 * Fetch the manifest (package.json) file from the package folder.
 * @param packageObject A PackageIdentifier Object with both name and version keys
 * @returns The content of the package manifest as a PackageManifest object
 */
export const getManifest = async (packageObject: PackageIdentifier): Promise<PackageManifest> => {
  const manifestPath: string = path.join(getPackageDirPath(packageObject), 'package', 'package.json');
  const manifestFile = await fs.readFile(manifestPath, { encoding: 'utf8' });
  if (manifestFile) {
    const manifest = JSON.parse(manifestFile);
    return manifest;
  } else {
    getLogger().warn(`Could not find package manifest for ${packageObject.id}@${packageObject.version}`);
    return { name: packageObject.id, version: packageObject.version };
  }
};

/**
 * Get a package's dependencies from the package manifest
 * @param packageObject A PackageIdentifier Object with both name and version keys
 * @returns The dependencies array from the package manifest
 */
export const getDependencies = async (packageObject: PackageIdentifier) => {
  return (await getManifest(packageObject))?.dependencies;
};

/**
 * Ensures that a package and all of its dependencies are installed in the global package cache.
 * If a version is not supplied, the latest release will be looked up and installed.
 * @param packageId string in the format packageId@version | packageId | packageId#version
 */

export const install = async (packageId: string | PackageIdentifier, logger?: ILogger) => {
  if (logger) setLogger(logger);
  let packageObject: PackageIdentifier;
  if (typeof packageId === 'string') {
    packageId = packageId.trim();
    if (packageId.length === 0) {
      getLogger().error('Invalid package identifier: empty string');
      throw new Error('Invalid package identifier: empty string');
    };
    packageObject = await toPackageObject(packageId);
  } else {
    packageObject = packageId;
  }
  const installed = isInstalled(packageObject);
  if (!installed) {
    try {
      const tempPath: string = await downloadTarball(packageObject);
      await cachePackageTarball(packageObject, tempPath);
    } catch (e) {
      getLogger().error(e);
      throw new Error(`Failed to install package ${packageId}`);
    }
  };
  await getPackageIndexFile(packageObject);
  // package itself is installed now. Ensure dependencies.
  const deps = await getDependencies(packageObject);
  for (const pack in deps) {
    await install(pack + '@' + deps[pack]);
  };
  return true;
};

