// The DMZ path convention: inside `P/dmz/`, the folder names the provider and the file names the consumer.
// `.self` is the code in `P/_/`, `.parent` is what `P` receives from (or exposes to) the level above.

export const SELF = '.self';
export const PARENT = '.parent';
/** Consumer name of the file a bucket publishes to other projects: `P/dmz/<child>/.external.ts`. */
export const EXTERNAL = '.external';

export interface DmzFile {
  /** Project path of the DMZ file, such as `root/billing/dmz/.parent/invoices.ts`. */
  file: string;
  /** Bucket that owns the `dmz/` folder (`P`). */
  owner: string;
  /** Child name, `.self` or `.parent`. */
  provider: string;
  /** Child name, `.self` or `.parent`. */
  consumer: string;
}

export interface DmzOwner {
  path: string;
  /** Names of the child buckets of the owner. */
  children: string[];
  isRoot: boolean;
}

/** Consumers a provider folder can hold, or `null` when the provider folder itself is not valid. */
export function allowedConsumers(owner: DmzOwner, provider: string): string[] | null {
  if (provider === SELF) return [...owner.children];
  if (provider === PARENT) return owner.isRoot ? null : [...owner.children];
  if (!owner.children.includes(provider)) return null;
  const consumers = owner.children.filter((c) => c !== provider);
  consumers.push(SELF);
  if (!owner.isRoot) consumers.push(PARENT);
  consumers.push(EXTERNAL);
  return consumers;
}

/** Providers the owner's `dmz/` folder can hold. */
export function allowedProviders(owner: DmzOwner): string[] {
  const providers = [...owner.children, SELF];
  if (!owner.isRoot) providers.push(PARENT);
  return providers;
}

function list(names: string[]): string {
  return names.length === 0 ? '(none)' : names.join(', ');
}

/**
 * Validates a file found in `owner/dmz/`. `rel` is the path inside `dmz/`.
 * Returns the parsed DMZ file, or an error message written for the AI.
 */
export function classifyDmzPath(owner: DmzOwner, rel: string, dmzExtension: string): DmzFile | { error: string } {
  const file = `${owner.path}/dmz/${rel}`;
  const segments = rel.split('/');
  const convention = `Inside ${owner.path}/dmz/ the folder names the provider and the file names the consumer: dmz/<provider>/<consumer>${dmzExtension}.`;
  if (segments.length !== 2) {
    return {
      error: `${file} does not follow the DMZ layout. ${convention} Move the re-exports into a file at that depth or delete this file.`,
    };
  }
  const [provider, fileName] = segments as [string, string];
  const providers = allowedProviders(owner);
  if (!providers.includes(provider)) {
    const why =
      provider === PARENT
        ? `The root bucket has no parent, so ${owner.path}/dmz/ cannot have a ${PARENT} folder.`
        : `"${provider}" is not a child bucket of ${owner.path}, and it is not ${SELF}${owner.isRoot ? '' : ` or ${PARENT}`}.`;
    return { error: `${file} has an invalid provider folder. ${why} Valid provider folders here: ${list(providers)}. ${convention}` };
  }
  if (!fileName.endsWith(dmzExtension) || fileName.length === dmzExtension.length) {
    return { error: `${file} must use the ${dmzExtension} extension. ${convention} Rename or delete it.` };
  }
  const consumer = fileName.slice(0, -dmzExtension.length);
  const consumers = allowedConsumers(owner, provider)!;
  if (!consumers.includes(consumer)) {
    let why: string;
    if (consumer === provider) why = `A bucket cannot be a consumer of itself.`;
    else if (consumer === PARENT && owner.isRoot) why = `The root bucket has no parent, so nothing can be exposed through ${PARENT}.`;
    else if (consumer === EXTERNAL) why = `Only a child bucket publishes to other projects, so ${EXTERNAL}${dmzExtension} belongs in ${owner.path}/dmz/<child>/, never under ${provider}/.`;
    else if (provider === SELF || provider === PARENT) why = `Under ${provider}/ the file must name a child bucket of ${owner.path} that consumes it.`;
    else why = `"${consumer}" is not a sibling bucket of ${provider}, and it is not ${SELF}${owner.isRoot ? '' : ` or ${PARENT}`}.`;
    return {
      error: `${file} names an invalid consumer "${consumer}". ${why} Valid consumers in ${owner.path}/dmz/${provider}/: ${list(consumers.map((c) => c + dmzExtension))}.`,
    };
  }
  return { file, owner: owner.path, provider, consumer };
}
