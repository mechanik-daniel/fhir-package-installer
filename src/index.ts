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

import type {
  ILogger,
  FpiConfig,
  FileInPackageIndex,
  PackageIdentifier,
  PackageIndex,
  PackageManifest,
  PackageResource
} from './types';

/**
 * default logger uses global console methods
 */
const defaultLogger: ILogger = {
  info: (msg: any) => console.log(msg),
  warn: (msg: any) => console.warn(msg),
  error: (msg: any) => console.error(msg)
};

export class FhirPackageInstaller {
  private logger: ILogger = defaultLogger;
  private registryUrl = 'https://packages.fhir.org';
  private fallbackUrlBase = 'https://packages.simplifier.net';
  /**
   * Path to the FHIR package cache directory.
   * This directory is used to store downloaded and extracted FHIR packages.
   * If the directory does not exist, it will be created.
   */
  private cachePath: string = path.join(os.homedir(), '.fhir', 'packages');

  
  constructor(config?: FpiConfig) {
    const { logger, registryUrl, cachePath } = config || {} as FpiConfig;
    if (registryUrl) {
      this.registryUrl = registryUrl;
    }
    if (cachePath) {
      this.cachePath = cachePath;
    }
    if (logger) {
      this.logger = logger;
    }
    if (!fs.existsSync(this.cachePath)) {
      fs.mkdirSync(this.cachePath, { recursive: true });
      this.logger.info(`Directory '${this.cachePath}' created successfully.`);
    }
  }

  /**
   * Takes a PackageIdentifier Object and returns the corresponding directory name of the package
   * @param packageObject A PackageObject with both name and version keys
   * @returns (string) Directory name in the standard format `name#version`
   */
  private toDirName(packageObject: PackageIdentifier): string {
    return packageObject.id + '#' + packageObject.version;
  }

  /**
   * Takes a PackageIdentifier Object and returns the path to the package folder in the cache
   * @param packageObject A PackageIdentifier Object with both name and version keys
   * @returns The full path to the package directory
   */
  public getPackageDirPath(packageObject: PackageIdentifier): string {
    return path.join(this.cachePath, this.toDirName(packageObject));
  }

  /**
   * Get the full path to the .fpi.index.json file in the package folder
   * @param packageObject A PackageIdentifier Object with both name and version keys
   * @returns (string) The path to the package index file
   */
  private getPackageIndexPath(packageObject: PackageIdentifier): string {
    return path.join(this.getPackageDirPath(packageObject), 'package', '.fpi.index.json');
  }

  /**
   * Scans a package folder and generates a new `.fpi.index.json` file
   * @param packageObject The package identifier object
   * @returns PackageIndex
   */
  private async generatePackageIndex(packageObject: PackageIdentifier): Promise<PackageIndex> {
    this.logger.info(`Generating new .fpi.index.json file for package ${packageObject.id}@${packageObject.version}...`);
    const packagePath = this.getPackageDirPath(packageObject);
    const indexPath = this.getPackageIndexPath(packageObject);
    const evalAttribute = (att: any | any[]) => (typeof att === 'string' ? att : undefined);
    try {
      const fileList = await fs.readdir(path.join(packagePath, 'package'));
      const files = await Promise.all(
        fileList.filter(
          file => file.endsWith('.json') && file !== 'package.json' && !file.endsWith('.index.json')
        ).map(
          async (file: string) => {
            const content: PackageResource = await fs.readJSON(path.join(packagePath, 'package', file), { encoding: 'utf8' });
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
      await fs.writeJSON(indexPath, indexJson);
      return indexJson;
    } catch (e) {
      this.logger.error(e);
      throw e;
    }
  }

  private fetchJson(url: string): Promise<any> {
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

  private fetchStream(url: string): Promise<Readable> {
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

  private async getPackageDataFromRegistry(packageName: string): Promise<Record<string, any>> {
    return await this.fetchJson(`${this.registryUrl}/${packageName}/`);
  }

  private async getTarballUrl(packageObject: PackageIdentifier): Promise<string> {
    try {
      const packageData = await this.getPackageDataFromRegistry(packageObject.id);
      return packageData.versions[packageObject.version]?.dist?.tarball;
    } catch {
      return `${this.fallbackUrlBase}/${packageObject.id}/-/${packageObject.id}-${packageObject.version}.tgz`;
    }
  }

  private async downloadTarball(packageObject: PackageIdentifier): Promise<string> {
    const tarballUrl = await this.getTarballUrl(packageObject);
    const tarballStream = await this.fetchStream(tarballUrl);
    try {
      temp.track();
      const tempDirectory = temp.mkdirSync();
      await pipeline(tarballStream, tar.x({ cwd: tempDirectory }));
      this.logger.info(`Downloaded ${packageObject.id}@${packageObject.version} to a temporary directory`);
      return tempDirectory;
    } catch (e) {
      this.logger.error(`Failed to extract tarball of package ${packageObject.id}@${packageObject.version}`);
      throw e;
    }
  }

  private async cachePackageTarball(packageObject: PackageIdentifier, tempDirectory: string): Promise<string> {
    const finalPath = this.getPackageDirPath(packageObject);
    if (!this.isInstalled(packageObject)) {
      await fs.move(tempDirectory, finalPath);
      this.logger.info(`Installed ${packageObject.id}@${packageObject.version} in the FHIR package cache: ${finalPath}`);
    }
    return finalPath;
  }

  /**
   * Extracts the version of the package from a raw package identifier string.
   * Supported formats: `name@version`, `name#version`, or just `name`
   * @param packageId Raw package identifier string
   * @returns The version part or 'latest' if not supplied
   */
  private getVersionFromPackageString(packageId: string): string {
    const byPound = packageId.split('#');
    const byAt = packageId.split('@');
    if (byPound.length === 2) return byPound[1];
    if (byAt.length === 2) return byAt[1];
    return 'latest';
  }

  public isInstalled(packageObject: PackageIdentifier): boolean {
    return fs.existsSync(this.getPackageDirPath(packageObject));
  }

  public async getPackageIndexFile(packageObject: PackageIdentifier): Promise<PackageIndex> {
    const indexPath = this.getPackageIndexPath(packageObject);
    if (await fs.exists(indexPath)) {
      return await fs.readJSON(indexPath, { encoding: 'utf8' });
    }
    return await this.generatePackageIndex(packageObject);
  }

  public async checkLatestPackageDist(packageName: string): Promise<string> {
    const packageData = await this.getPackageDataFromRegistry(packageName);
    return packageData['dist-tags']?.latest;
  }

  public async toPackageObject(packageId: string): Promise<PackageIdentifier> {
    const packageName = packageId.split('#')[0].split('@')[0];
    let packageVersion = this.getVersionFromPackageString(packageId);
    if (packageVersion === 'latest') packageVersion = await this.checkLatestPackageDist(packageName);
    return { id: packageName, version: packageVersion };
  }

  public async getManifest(packageObject: PackageIdentifier): Promise<PackageManifest> {
    const manifestPath = path.join(this.getPackageDirPath(packageObject), 'package', 'package.json');
    const manifestFile = await fs.readJSON(manifestPath, { encoding: 'utf8' });
    if (manifestFile) {
      return manifestFile;
    } else {
      this.logger.warn(`Could not find package manifest for ${packageObject.id}@${packageObject.version}`);
      return { name: packageObject.id, version: packageObject.version };
    }
  }

  /**
   * Get the path to the FHIR package cache directory.
   * This directory is used to store downloaded and extracted FHIR packages.
   * If the directory does not exist, it will be created.
   * @returns {string} The path to the FHIR package cache directory
   */
  public getCachePath(): string {
    return this.cachePath;
  }

  public async getDependencies(packageObject: PackageIdentifier) {
    return (await this.getManifest(packageObject))?.dependencies;
  }

  public async install(packageId: string | PackageIdentifier): Promise<boolean> {
    let packageObject: PackageIdentifier;
    if (typeof packageId === 'string') {
      packageId = packageId.trim();
      if (packageId.length === 0) {
        this.logger.error('Invalid package identifier: empty string');
        throw new Error('Invalid package identifier: empty string');
      }
      packageObject = await this.toPackageObject(packageId);
    } else {
      packageObject = packageId;
    }

    if (!this.isInstalled(packageObject)) {
      try {
        const tempPath = await this.downloadTarball(packageObject);
        await this.cachePackageTarball(packageObject, tempPath);
      } catch (e) {
        this.logger.error(e);
        throw new Error(`Failed to install package ${packageObject.id}@${packageObject.version}`);
      }
    }

    await this.getPackageIndexFile(packageObject);
    const deps = await this.getDependencies(packageObject);
    for (const dep in deps) {
      await this.install(`${dep}@${deps[dep]}`);
    }
    return true;
  }
}

/**
 * Default instance export for convenience
 */
const fpi = new FhirPackageInstaller();
export default fpi;

export type {
  ILogger,
  PackageIdentifier,
  PackageIndex,
  PackageManifest,
  FileInPackageIndex,
  PackageResource
} from './types';
