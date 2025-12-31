/**
 * © Copyright Outburn Ltd. 2022-2025 All Rights Reserved
 *   Project name: FHIR-Package-Installer
 */

import { Logger } from '@outburn/types';
import { ILatestVersionCache } from './LatestVersionCache';

/**
 * The structure of the FPI constructor config object.
 */
export interface FpiConfig {
    logger?: Logger
    registryUrl?: string
    registryToken?: string
    cachePath?: string
    skipExamples?: boolean // skip dependency installation of example packages
    allowHttp?: boolean // allow HTTP URLs for testing (default: false)
    latestVersionCache?: ILatestVersionCache // cache for FHIR package latest versions (default: in-memory cache with 5-minute TTL)
    requestTimeoutMs?: number // HTTP request timeout (default: 90000)
    extractTimeoutMs?: number // tarball extraction timeout (default: 60000)
  }
  