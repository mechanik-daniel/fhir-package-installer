/**
 * © Copyright Outburn Ltd. 2022-2025 All Rights Reserved
 *   Project name: FHIR-Package-Installer
 */
import { PackageIndex } from './PackageIndex';
/**
 * A basic interface for package.json structure with some extra elements
 */
export interface PackageManifest {
    name: string;
    version: string;
    dependencies?: {
        [key: string]: string;
    };
    installedPath?: string;
    '.index.json'?: PackageIndex;
    [key: string]: any;
}
//# sourceMappingURL=PackageManifest.d.ts.map