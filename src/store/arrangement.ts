import { join } from 'node:path';
import { z } from 'zod';
import {
  IArrangementSkeleton,
  ICurrentArrangement,
  IMotifBundle,
  ISegmentCard,
} from '../protocol/schema.js';
import { readJsonOrNull, writeJson } from './writer.js';

const IMotifBundleFile = z.array(IMotifBundle);
const IArrangementSkeletonFile = z.array(IArrangementSkeleton);
const ISegmentCardFile = z.array(ISegmentCard);

export function getMotifBundlesPath(projectRoot: string): string {
  return join(projectRoot, 'analysis', 'motif-bundles.json');
}

export function getArrangementSkeletonsPath(projectRoot: string): string {
  return join(projectRoot, 'script', 'arrangement-skeletons.json');
}

export function getSegmentCardsPath(projectRoot: string): string {
  return join(projectRoot, 'script', 'segment-cards.json');
}

export function getCurrentArrangementPath(projectRoot: string): string {
  return join(projectRoot, 'script', 'arrangement.current.json');
}

export async function loadMotifBundles(projectRoot: string): Promise<IMotifBundle[]> {
  return (await readJsonOrNull(getMotifBundlesPath(projectRoot), IMotifBundleFile) as IMotifBundle[] | null) ?? [];
}

export async function writeMotifBundles(
  projectRoot: string,
  bundles: IMotifBundle[],
): Promise<void> {
  await writeJson(getMotifBundlesPath(projectRoot), bundles);
}

export async function loadArrangementSkeletons(projectRoot: string): Promise<IArrangementSkeleton[]> {
  return (await readJsonOrNull(
    getArrangementSkeletonsPath(projectRoot),
    IArrangementSkeletonFile,
  ) as IArrangementSkeleton[] | null) ?? [];
}

export async function writeArrangementSkeletons(
  projectRoot: string,
  skeletons: IArrangementSkeleton[],
): Promise<void> {
  await writeJson(getArrangementSkeletonsPath(projectRoot), skeletons);
}

export async function loadSegmentCards(projectRoot: string): Promise<ISegmentCard[]> {
  return (await readJsonOrNull(getSegmentCardsPath(projectRoot), ISegmentCardFile) as ISegmentCard[] | null) ?? [];
}

export async function writeSegmentCards(
  projectRoot: string,
  cards: ISegmentCard[],
): Promise<void> {
  await writeJson(getSegmentCardsPath(projectRoot), cards);
}

export async function loadCurrentArrangement(
  projectRoot: string,
): Promise<ICurrentArrangement | null> {
  return readJsonOrNull(
    getCurrentArrangementPath(projectRoot),
    ICurrentArrangement,
  ) as Promise<ICurrentArrangement | null>;
}

export async function writeCurrentArrangement(
  projectRoot: string,
  arrangement: ICurrentArrangement,
): Promise<void> {
  await writeJson(getCurrentArrangementPath(projectRoot), arrangement);
}
