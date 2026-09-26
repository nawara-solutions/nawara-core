/**
 * The Release Management domain (ADR-0051 §3), product-independent. `Product` is a release-registry key: it is NOT Billing's commercial
 * product (no price, plan, subscription or entitlement) and NOT Core's tenant `Platform`. There is no deployment, environment,
 * artifact, channel or tenant concept.
 */

/**
 * The kinds of a component, fixed by ADR-0051. Web is first-class (a deployed bundle a browser loads); desktop is technology-neutral
 * (Tauri is one possible technology, never a kind); iOS and Android are distinct. Backend components are registered for traceability
 * only (they have no compatibility policy). `ai` is reserved by ADR-0051 for a later stage and is not accepted yet.
 */
export const COMPONENT_KINDS = ['backend', 'web', 'desktop', 'mobile_ios', 'mobile_android'] as const;
export type ComponentKind = (typeof COMPONENT_KINDS)[number];

/** A client component has a compatibility policy; a backend does not. */
export const isClientKind = (kind: ComponentKind): boolean => kind !== 'backend';

/** The release lifecycle, exactly `registered → published → withdrawn` (ADR-0051 §3). */
export const RELEASE_STATUSES = ['registered', 'published', 'withdrawn'] as const;
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];

/** A registry key (product or component): lowercase, stable. The database checks the same shape. */
export const REGISTRY_KEY = /^[a-z][a-z0-9-]{0,62}$/;

/** A native build identity (iOS build number, Android versionCode, a CI build number): printable ASCII, no space. Never compared. */
export const BUILD_ID = /^[!-~]{1,128}$/;
/** A source revision: a lowercase hexadecimal commit id (abbreviated or full). Traceability only. */
export const SOURCE_REVISION = /^[0-9a-f]{7,64}$/;
/** A release-notes reference (a URL or document id): printable ASCII, no space. Never fetched by the service. */
export const NOTES_REF = /^[!-~]{1,512}$/;

export interface Product {
  id: string;
  key: string;
  createdAt: Date;
}

export interface Component {
  id: string;
  productId: string;
  key: string;
  kind: ComponentKind;
  createdAt: Date;
}

/** The immutable identity of a release: everything but its lifecycle. */
export interface ReleaseIdentity {
  componentId: string;
  /** Canonical SemVer (no build metadata): the only compared value. */
  version: string;
  /** Native build identity (iOS build number, Android versionCode, a build number): stored, never compared. */
  buildId: string | null;
  /** Source revision (a Git SHA): traceability only. */
  sourceRevision: string | null;
  notesRef: string | null;
}

export interface Release extends ReleaseIdentity {
  id: string;
  status: ReleaseStatus;
  registeredAt: Date;
  publishedAt: Date | null;
  withdrawnAt: Date | null;
}

export interface CompatibilityPolicy {
  componentId: string;
  /** 1, 2, 3, … per component; each change is a new version (append-only). */
  policyVersion: number;
  /** A stable version (no pre-release): clients below it, or on a withdrawn release, must update (the decision is Stage 20.5). */
  minimumVersion: string;
  createdAt: Date;
}
