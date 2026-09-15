"use client";
import { ReleaseForm } from "./release-form";
export type ReleaseRelationshipOption = { id: string; name: string; legacyId?: number; active?: boolean };
export function ReleaseCreateForm(props: { artists: ReleaseRelationshipOption[]; labels: ReleaseRelationshipOption[] }) { return <ReleaseForm {...props} />; }
