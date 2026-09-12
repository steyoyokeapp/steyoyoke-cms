export type StorageOwnershipAttestation = {
  runId: string;
  storageKey: string;
  sha256Checksum: string;
};

const INCIDENT_RUN_ID = "0ec15dbc-fe58-5a53-a43a-c2cdfef20f76";
const INCIDENT_ASSET_ID = "f3279f54-268d-55e7-9a64-0fc18ddca2bc";

// Verified from the immutable production objects with the inventory-readonly AWS identity on 2026-09-12.
export const HISTORICAL_STORAGE_OWNERSHIP_ATTESTATIONS: readonly StorageOwnershipAttestation[] = [
  { runId: INCIDENT_RUN_ID, storageKey: `images/${INCIDENT_ASSET_ID}/original.jpg`, sha256Checksum: "8015133396622d666057f7f1cd683201e24841dd3f024033cfa144879a5598b9" },
  { runId: INCIDENT_RUN_ID, storageKey: `images/${INCIDENT_ASSET_ID}/legacy-1440.jpg`, sha256Checksum: "8015133396622d666057f7f1cd683201e24841dd3f024033cfa144879a5598b9" },
  { runId: INCIDENT_RUN_ID, storageKey: `images/${INCIDENT_ASSET_ID}/legacy-1024.jpg`, sha256Checksum: "29a310098d8e39945b4dd8cd75dd0a366feb7a4fe423b5cf2fc72e7096be0e0f" },
  { runId: INCIDENT_RUN_ID, storageKey: `images/${INCIDENT_ASSET_ID}/legacy-512.jpg`, sha256Checksum: "91256f2cdc2b45fdf4f06738850ecb61e80394e48547d7b6b6ca9c09767d42f3" },
  { runId: INCIDENT_RUN_ID, storageKey: `images/${INCIDENT_ASSET_ID}/legacy-thumb-256.jpg`, sha256Checksum: "ca638d118eb76401fe422bc8972263ddc5a71176c65663d5fb51a4ae09bc27f0" },
  { runId: INCIDENT_RUN_ID, storageKey: `images/${INCIDENT_ASSET_ID}/legacy-thumb-80.jpg`, sha256Checksum: "b98b7fb51c1654d55951d2923722cda367f38f202b14bb0b99bb578692db4f50" },
];

const attestationIdentity = ({ runId, storageKey, sha256Checksum }: StorageOwnershipAttestation) => `${runId}\n${storageKey}\n${sha256Checksum.toLowerCase()}`;
const approvedAttestations = new Set(HISTORICAL_STORAGE_OWNERSHIP_ATTESTATIONS.map(attestationIdentity));

export function historicalAttestationsForRun(runId: string) {
  return HISTORICAL_STORAGE_OWNERSHIP_ATTESTATIONS.filter((attestation) => attestation.runId === runId);
}

export function assertApprovedHistoricalAttestations(runId: string, attestations: readonly StorageOwnershipAttestation[]) {
  for (const attestation of attestations) {
    if (attestation.runId !== runId || !approvedAttestations.has(attestationIdentity(attestation))) {
      throw new Error(`Unapproved historical storage ownership attestation for ${attestation.storageKey}.`);
    }
  }
}
