// Signature hash of a DMZ symbol.
//
// The hash is "sha256:" plus the hex sha256 of a text that describes the symbol's
// structure as the checker sees it. The text never contains source positions or
// absolute paths, so it stays the same across machines, across formatting changes
// and across edits to function bodies that keep the inferred types.
//
// Rules of the description:
// - Aliases are followed to the declaration.
// - Classes, interfaces and object types list their properties (name, optional,
//   readonly, type), call and construct signatures and index signatures.
// - Members also carry what a subclass or caller depends on: `protected`,
//   `abstract`, method or property, and accessors (a getter alone reads as
//   `readonly`). Private members are left out, so a member that becomes private
//   disappears from the text. Classes add `abstract` and the accessibility of
//   their constructor.
// - Named types declared in the project are expanded up to MAX_NAMED_DEPTH levels
//   below the symbol. Past that depth, or when the type is already being expanded
//   (a cycle), only the name and type arguments are written.
// - Named types from lib files or node_modules are never expanded. They appear as
//   their name and type arguments, such as Promise<string>.
// - Functions list every overload with type parameters, the `this` parameter,
//   parameters (name, optional, rest, type) and return type.
// - Mapped types are described by their parts (type parameter constraint, `as`
//   clause, template, readonly and optional modifiers), never printed.
// - Union and intersection members are sorted, because the checker orders them by
//   internal type id, which depends on the order it met them.

import { createHash } from 'node:crypto';
import type * as TS from 'typescript';
import type { TypeScript } from './env.js';

const MAX_NAMED_DEPTH = 3;
// Anonymous object types have no name to fall back to, so they always expand.
// This cap only stops pathological nesting.
const MAX_ANONYMOUS_DEPTH = 12;

export class SignatureHasher {
  private readonly cache = new Map<TS.Symbol, string>();
  private readonly projectPrefix: RegExp;
  private readonly folders: { pattern: RegExp; to: string }[];

  /**
   * `folders` lists absolute folders that the description writes as `to` instead, applied longest first and before
   * the project folder is removed. Links use it: a file reached through a junction has the origin's real path, a
   * copied file has a path inside the project, and both must describe the same way.
   */
  constructor(
    private readonly ts: TypeScript,
    private readonly program: TS.Program,
    private readonly checker: TS.TypeChecker,
    projectDir: string,
    folders: { dir: string; to: string }[] = [],
  ) {
    this.projectPrefix = new RegExp(`${escapeRegExp(toSlashes(projectDir))}/?`, 'gi');
    this.folders = folders
      .map(({ dir, to }) => ({ dir: toSlashes(dir), to }))
      .sort((a, b) => b.dir.length - a.dir.length)
      .map(({ dir, to }) => ({ pattern: new RegExp(`${escapeRegExp(dir)}/`, 'gi'), to }));
  }

  /** Follows aliases from `symbol` and hashes the declaration it reaches. */
  hash(symbol: TS.Symbol): string {
    const target = this.resolveAlias(symbol);
    let hash = this.cache.get(target);
    if (hash === undefined) {
      hash = `sha256:${createHash('sha256').update(this.describe(target)).digest('hex')}`;
      this.cache.set(target, hash);
    }
    return hash;
  }

  /** The text that `hash` digests. Exposed for tests and debugging. */
  describe(symbol: TS.Symbol): string {
    return this.sanitize(this.describeSymbol(this.resolveAlias(symbol), 0));
  }

  private resolveAlias(symbol: TS.Symbol): TS.Symbol {
    return symbol.flags & this.ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(symbol) : symbol;
  }

  private describeSymbol(symbol: TS.Symbol, depth: number): string {
    const { SymbolFlags, SignatureKind } = this.ts;
    const flags = symbol.flags;
    const parts: string[] = [];
    const path = new Set<TS.Type>();

    if (flags & SymbolFlags.Class) {
      const abstract = (symbol.declarations ?? []).some((d) => this.modifierFlags(d) & this.ts.ModifierFlags.Abstract) ? 'abstract ' : '';
      parts.push(`${abstract}class${this.typeParametersOf(symbol, depth)} ${this.describeClass(symbol, depth)}`);
    } else if (flags & (SymbolFlags.Function | SymbolFlags.Method)) {
      const type = this.checker.getTypeOfSymbol(symbol);
      const signatures = this.checker.getSignaturesOfType(type, SignatureKind.Call);
      parts.push(`function ${signatures.map((s) => this.describeSignature(s, depth, path)).join(' & ')}`);
    } else if (flags & (SymbolFlags.Variable | SymbolFlags.Property)) {
      parts.push(`value ${this.describeType(this.checker.getTypeOfSymbol(symbol), depth, path)}`);
    }
    if (flags & SymbolFlags.Interface) {
      const declared = this.checker.getDeclaredTypeOfSymbol(symbol);
      // The interface itself is being expanded, so a property of its own type is a cycle.
      parts.push(`interface${this.typeParametersOf(symbol, depth)} ${this.describeStructure(declared, depth, new Set([declared]))}`);
    }
    if (flags & SymbolFlags.TypeAlias) {
      const declared = this.checker.getDeclaredTypeOfSymbol(symbol);
      // As with interfaces, a reference to the alias inside its own definition is a cycle.
      // An alias of an anonymous type, such as `typeof import('./x')`, does not name it.
      const own = new Set(declared.aliasSymbol === symbol ? [declared] : []);
      parts.push(`type${this.typeParametersOf(symbol, depth)} ${this.describeType(declared, depth, own, true)}`);
    }
    if (flags & SymbolFlags.Enum) {
      parts.push(`enum ${this.describeEnum(symbol)}`);
    }
    if (flags & SymbolFlags.EnumMember) {
      parts.push(`enum-member ${this.enumMemberValue(symbol)}`);
    }
    if (flags & (SymbolFlags.ValueModule | SymbolFlags.NamespaceModule)) {
      parts.push(`namespace ${this.describeNamespace(symbol, depth)}`);
    }
    if (parts.length === 0) {
      parts.push(`unknown ${this.describeType(this.checker.getTypeOfSymbol(symbol), depth, path)}`);
    }
    return parts.join('\n');
  }

  private describeClass(symbol: TS.Symbol, depth: number): string {
    const { SignatureKind } = this.ts;
    const staticType = this.checker.getTypeOfSymbol(symbol);
    const instance = this.checker.getDeclaredTypeOfSymbol(symbol);
    const path = new Set<TS.Type>([staticType, instance]);
    const members: string[] = [];
    for (const signature of this.checker.getSignaturesOfType(staticType, SignatureKind.Construct)) {
      // A private or protected constructor stops callers from writing `new`.
      const declaration = signature.getDeclaration() as TS.SignatureDeclaration | undefined;
      const flags = declaration === undefined ? 0 : this.modifierFlags(declaration);
      const access = flags & this.ts.ModifierFlags.Private ? 'private ' : flags & this.ts.ModifierFlags.Protected ? 'protected ' : '';
      members.push(`${access}new ${this.describeSignature(signature, depth, path)}`);
    }
    for (const property of this.visibleProperties(staticType)) {
      if (property.name === 'prototype') continue;
      members.push(`static ${this.describeProperty(property, depth, path)}`);
    }
    members.push(`instance ${this.describeStructure(instance, depth, path)}`);
    return `{ ${members.join('; ')} }`;
  }

  private describeEnum(symbol: TS.Symbol): string {
    const members = this.checker.getExportsOfModule(symbol).filter((m) => m.flags & this.ts.SymbolFlags.EnumMember);
    return `{ ${members.map((m) => `${m.name} = ${this.enumMemberValue(m)}`).join('; ')} }`;
  }

  private enumMemberValue(symbol: TS.Symbol): string {
    const declaration = symbol.valueDeclaration;
    if (declaration === undefined || !this.ts.isEnumMember(declaration)) return '?';
    return JSON.stringify(this.checker.getConstantValue(declaration) ?? null);
  }

  private describeNamespace(symbol: TS.Symbol, depth: number): string {
    if (depth >= MAX_NAMED_DEPTH) return '{ ... }';
    const members = [...this.checker.getExportsOfModule(symbol)].sort(byName);
    return `{ ${members.map((m) => `${m.name}: ${this.describeSymbol(this.resolveAlias(m), depth + 1).replace(/\n/g, ' + ')}`).join('; ')} }`;
  }

  /** Type parameters taken from the first declaration that has them. */
  private typeParametersOf(symbol: TS.Symbol, depth: number): string {
    for (const declaration of symbol.declarations ?? []) {
      const nodes = (declaration as { typeParameters?: TS.NodeArray<TS.TypeParameterDeclaration> }).typeParameters;
      if (nodes === undefined || nodes.length === 0) continue;
      const parameters = nodes.map((node) => this.checker.getTypeAtLocation(node) as TS.TypeParameter);
      return this.describeTypeParameters(parameters, depth, new Set());
    }
    return '';
  }

  private describeTypeParameters(parameters: readonly TS.TypeParameter[] | undefined, depth: number, path: Set<TS.Type>): string {
    if (parameters === undefined || parameters.length === 0) return '';
    const described = parameters.map((parameter) => {
      let text = parameter.symbol?.name ?? this.typeToString(parameter);
      // getConstraint() returns the base constraint, which turns `K extends keyof T` into `string | number | symbol`.
      const node = parameter.symbol?.declarations?.find((d) => this.ts.isTypeParameterDeclaration(d)) as TS.TypeParameterDeclaration | undefined;
      const constraint = node?.constraint !== undefined ? this.checker.getTypeFromTypeNode(node.constraint) : parameter.getConstraint();
      if (constraint !== undefined) text += ` extends ${this.describeType(constraint, depth + 1, path)}`;
      const fallback = parameter.getDefault();
      if (fallback !== undefined) text += ` = ${this.describeType(fallback, depth + 1, path)}`;
      return text;
    });
    return `<${described.join(', ')}>`;
  }

  private describeSignature(signature: TS.Signature, depth: number, path: Set<TS.Type>): string {
    const ts = this.ts;
    const typeParameters = this.describeTypeParameters(signature.getTypeParameters(), depth, path);
    // `thisParameter` is internal. getParameters() leaves the `this` parameter out.
    const thisParameter = (signature as { thisParameter?: TS.Symbol }).thisParameter;
    const self = thisParameter === undefined ? [] : [`this: ${this.describeType(this.checker.getTypeOfSymbol(thisParameter), depth + 1, path)}`];
    const parameters = signature.getParameters().map((parameter) => {
      const declaration = parameter.valueDeclaration;
      let rest = false;
      let optional = false;
      if (declaration !== undefined && ts.isParameter(declaration)) {
        rest = declaration.dotDotDotToken !== undefined;
        optional = this.checker.isOptionalParameter(declaration);
      }
      const type = this.describeType(this.checker.getTypeOfSymbol(parameter), depth + 1, path);
      return `${rest ? '...' : ''}${parameter.name}${optional ? '?' : ''}: ${type}`;
    });
    const predicate = this.checker.getTypePredicateOfSignature(signature);
    let result: string;
    if (predicate !== undefined) {
      const asserts = predicate.kind === ts.TypePredicateKind.AssertsThis || predicate.kind === ts.TypePredicateKind.AssertsIdentifier;
      const subject = predicate.kind === ts.TypePredicateKind.This || predicate.kind === ts.TypePredicateKind.AssertsThis ? 'this' : predicate.parameterName;
      const type = predicate.type === undefined ? '' : ` is ${this.describeType(predicate.type, depth + 1, path)}`;
      result = `${asserts ? 'asserts ' : ''}${subject}${type}`;
    } else {
      result = this.describeType(this.checker.getReturnTypeOfSignature(signature), depth + 1, path);
    }
    return `${typeParameters}(${[...self, ...parameters].join(', ')}) => ${result}`;
  }

  private describeType(type: TS.Type, depth: number, path: Set<TS.Type>, skipAlias = false): string {
    const named = skipAlias ? undefined : this.namedSymbol(type);
    if (named !== undefined) {
      const reference = this.reference(named, type, depth, path);
      if (this.isExternal(named) || depth > MAX_NAMED_DEPTH || path.has(type)) return reference;
      path.add(type);
      try {
        return `${reference} ${this.describeStructural(type, depth, path, true)}`;
      } finally {
        path.delete(type);
      }
    }
    return this.describeStructural(type, depth, path, skipAlias);
  }

  /** Describes `type` by its shape, ignoring the name it may have. */
  private describeStructural(type: TS.Type, depth: number, path: Set<TS.Type>, ignoreAlias = false): string {
    const { TypeFlags, SymbolFlags } = this.ts;
    if (type.flags & TypeFlags.Union && !(type.flags & TypeFlags.Boolean)) {
      if (type.flags & TypeFlags.EnumLiteral && type.symbol?.flags & SymbolFlags.Enum) return `enum ${this.describeEnum(type.symbol)}`;
      // Any other union, a subset of enum members included, is sorted.
      return this.joinSorted((type as TS.UnionType).types, ' | ', depth, path);
    }
    if (type.flags & TypeFlags.Intersection) {
      return this.joinSorted((type as TS.IntersectionType).types, ' & ', depth, path);
    }
    if (type.flags & TypeFlags.Object) {
      if (path.has(type) && this.namedSymbol(type) === undefined) return '<cycle>';
      if (depth > MAX_ANONYMOUS_DEPTH) return '{ ... }';
      path.add(type);
      try {
        return this.describeObject(type as TS.ObjectType, depth, path);
      } finally {
        path.delete(type);
      }
    }
    // The parts of these generic types can name project types, so they are
    // described like any other type instead of printed.
    if (type.flags & TypeFlags.Conditional) {
      const conditional = type as TS.ConditionalType;
      const node = conditional.root.node;
      const describe = (part: TS.Type) => this.describeType(part, depth + 1, path);
      const whenTrue = describe(this.checker.getTypeFromTypeNode(node.trueType));
      const whenFalse = describe(this.checker.getTypeFromTypeNode(node.falseType));
      return `(${describe(conditional.checkType)} extends ${describe(conditional.extendsType)} ? ${whenTrue} : ${whenFalse})`;
    }
    if (type.flags & TypeFlags.IndexedAccess) {
      const access = type as TS.IndexedAccessType;
      return `${this.describeType(access.objectType, depth + 1, path)}[${this.describeType(access.indexType, depth + 1, path)}]`;
    }
    if (type.flags & TypeFlags.Index) {
      return `keyof ${this.describeType((type as TS.IndexType).type, depth + 1, path)}`;
    }
    if (type.flags & TypeFlags.TemplateLiteral) {
      const template = type as TS.TemplateLiteralType;
      const spans = template.types.map((part, i) => `\${${this.describeType(part, depth + 1, path)}}${template.texts[i + 1] ?? ''}`);
      return `\`${template.texts[0] ?? ''}${spans.join('')}\``;
    }
    if (type.flags & TypeFlags.StringMapping) {
      const mapping = type as TS.StringMappingType;
      return `${mapping.symbol.name}<${this.describeType(mapping.type, depth + 1, path)}>`;
    }
    // Primitives, literals, enum members, unique symbols and type parameters
    // read the same in the checker's own printer.
    return this.typeToString(type, ignoreAlias);
  }

  private describeObject(type: TS.ObjectType, depth: number, path: Set<TS.Type>): string {
    if (this.checker.isTupleType(type)) {
      const reference = type as TS.TypeReference;
      const target = reference.target as TS.TupleType;
      const elements = this.checker.getTypeArguments(reference).map((element, i) => {
        const flags = target.elementFlags[i] ?? this.ts.ElementFlags.Required;
        const text = this.describeType(element, depth + 1, path);
        if (flags & this.ts.ElementFlags.Variadic) return `...${text}`;
        if (flags & this.ts.ElementFlags.Rest) return `...${text}[]`;
        if (flags & this.ts.ElementFlags.Optional) return `${text}?`;
        return text;
      });
      return `${target.readonly ? 'readonly ' : ''}[${elements.join(', ')}]`;
    }
    const structure = this.describeStructure(type, depth, path);
    // A generic mapped type has no properties until it is instantiated, so its
    // structure alone would read `{  }`. Its definition is described as well.
    if (type.objectFlags & this.ts.ObjectFlags.Mapped) return `${structure} mapped ${this.describeMapped(type, depth, path)}`;
    return structure;
  }

  /**
   * `{ readonly [K in C as N]?: T }` described part by part from its declaration, so unions inside are sorted.
   */
  private describeMapped(type: TS.ObjectType, depth: number, path: Set<TS.Type>): string {
    const ts = this.ts;
    const declaration = (type as { declaration?: TS.MappedTypeNode }).declaration;
    if (declaration === undefined) return '{ ? }';
    const describe = (part: TS.Type) => this.describeType(part, depth + 1, path);
    const fromNode = (node: TS.TypeNode | undefined) => (node === undefined ? undefined : this.checker.getTypeFromTypeNode(node));

    const constraint = fromNode(declaration.typeParameter.constraint);
    // `typeParameter` is internal. An instantiated mapped type (`Base<T[]>` seen from a subclass) gets its
    // own, whose base constraint carries the instantiation that the declaration nodes do not show.
    // `mapper` is internal too: only an instantiated mapped type has one.
    const own = (type as { typeParameter?: TS.TypeParameter }).typeParameter;
    const instantiated = (type as { mapper?: unknown }).mapper !== undefined;
    const base = own !== undefined && instantiated ? this.checker.getBaseConstraintOfType(own) : undefined;
    const nameType = fromNode(declaration.nameType);
    const template = fromNode(declaration.type);

    const modifier = (token: TS.Node | undefined, text: string) => {
      if (token === undefined) return '';
      return token.kind === ts.SyntaxKind.MinusToken ? `-${text}` : `+${text}`;
    };
    const readonly = modifier(declaration.readonlyToken, 'readonly');
    const optional = modifier(declaration.questionToken, '?');
    const as = nameType === undefined ? '' : ` as ${describe(nameType)}`;
    const baseText = base === undefined ? '' : ` (base ${describe(base)})`;
    const key = `${declaration.typeParameter.name.text} in ${constraint === undefined ? 'unknown' : describe(constraint)}${baseText}${as}`;
    return `{ ${readonly === '' ? '' : `${readonly} `}[${key}]${optional}: ${template === undefined ? 'any' : describe(template)} }`;
  }

  /** Properties, signatures and index signatures of an object, class instance or interface type. */
  private describeStructure(type: TS.Type, depth: number, path: Set<TS.Type>): string {
    const { SignatureKind } = this.ts;
    const members: string[] = [];
    for (const signature of this.checker.getSignaturesOfType(type, SignatureKind.Call)) {
      members.push(this.describeSignature(signature, depth, path));
    }
    for (const signature of this.checker.getSignaturesOfType(type, SignatureKind.Construct)) {
      members.push(`new ${this.describeSignature(signature, depth, path)}`);
    }
    for (const info of this.checker.getIndexInfosOfType(type)) {
      const key = this.describeType(info.keyType, depth + 1, path);
      const value = this.describeType(info.type, depth + 1, path);
      members.push(`${info.isReadonly ? 'readonly ' : ''}[key: ${key}]: ${value}`);
    }
    for (const property of this.visibleProperties(type)) {
      members.push(this.describeProperty(property, depth, path));
    }
    return `{ ${members.join('; ')} }`;
  }

  private describeProperty(property: TS.Symbol, depth: number, path: Set<TS.Type>): string {
    const { ModifierFlags, SymbolFlags } = this.ts;
    const flags = property.flags;
    const optional = flags & SymbolFlags.Optional ? '?' : '';
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    const modifiers = declaration === undefined ? 0 : this.modifierFlags(declaration);
    const words: string[] = [];
    if (modifiers & ModifierFlags.Protected) words.push('protected');
    if (modifiers & ModifierFlags.Abstract) words.push('abstract');
    // A getter without a setter cannot be assigned, like a readonly property.
    const getterOnly = flags & SymbolFlags.GetAccessor && !(flags & SymbolFlags.SetAccessor);
    if (modifiers & ModifierFlags.Readonly || getterOnly) words.push('readonly');
    if (flags & SymbolFlags.SetAccessor) words.push(flags & SymbolFlags.GetAccessor ? 'get set' : 'set');
    // A method and a property of function type differ in variance and in how a subclass may override them.
    if (flags & SymbolFlags.Method) words.push('method');
    const type = this.describeType(this.checker.getTypeOfSymbol(property), depth + 1, path);
    const prefix = words.length === 0 ? '' : `${words.join(' ')} `;
    return `${prefix}${this.propertyName(property)}${optional}: ${type}`;
  }

  /** Modifier flags of a declaration, parameter properties (`constructor(protected x)`) included. */
  private modifierFlags(declaration: TS.Declaration): TS.ModifierFlags {
    return this.ts.getCombinedModifierFlags(declaration);
  }

  /**
   * A property keyed by a unique symbol has an internal name with a symbol id
   * (`__@sym@18`) that changes between runs. The printer's `[sym]` is stable.
   */
  private propertyName(property: TS.Symbol): string {
    return property.name.startsWith('__@') ? this.checker.symbolToString(property) : property.name;
  }

  /** Public and protected properties sorted by name. Private members are not part of a contract. */
  private visibleProperties(type: TS.Type): TS.Symbol[] {
    const ts = this.ts;
    return this.checker
      .getPropertiesOfType(type)
      .filter((property) => {
        if (property.name.startsWith('__#')) return false;
        const declaration = property.valueDeclaration;
        if (declaration === undefined) return true;
        if (ts.isPrivateIdentifier((declaration as { name?: TS.Node }).name ?? declaration)) return false;
        return !(ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Private);
      })
      .map((property) => ({ property, name: this.propertyName(property) }))
      .sort((a, b) => compare(a.name, b.name))
      .map(({ property }) => property);
  }

  /** The symbol that names `type`: its type alias, or the class, interface or enum it is an instance of. */
  private namedSymbol(type: TS.Type): TS.Symbol | undefined {
    const { SymbolFlags, TypeFlags, ObjectFlags } = this.ts;
    if (type.aliasSymbol !== undefined) return type.aliasSymbol;
    const symbol = type.symbol as TS.Symbol | undefined;
    if (symbol === undefined) return undefined;
    if (type.flags & TypeFlags.Object) {
      const objectFlags = (type as TS.ObjectType).objectFlags;
      if (objectFlags & (ObjectFlags.Class | ObjectFlags.Interface | ObjectFlags.Reference) && symbol.flags & (SymbolFlags.Class | SymbolFlags.Interface)) {
        return symbol;
      }
    }
    if (type.flags & TypeFlags.Union && type.flags & TypeFlags.EnumLiteral && symbol.flags & SymbolFlags.Enum) return symbol;
    return undefined;
  }

  /** Name plus type arguments, such as `Box<string>`. */
  private reference(symbol: TS.Symbol, type: TS.Type, depth: number, path: Set<TS.Type>): string {
    let typeArguments: readonly TS.Type[] = [];
    if (type.aliasSymbol === symbol) {
      typeArguments = type.aliasTypeArguments ?? [];
    } else if (type.flags & this.ts.TypeFlags.Object && (type as TS.ObjectType).objectFlags & this.ts.ObjectFlags.Reference) {
      const reference = type as TS.TypeReference;
      const count = reference.target.typeParameters?.length ?? 0;
      typeArguments = this.checker.getTypeArguments(reference).slice(0, count);
    }
    if (typeArguments.length === 0) return symbol.name;
    const args = typeArguments.map((arg) => this.describeType(arg, depth + 1, path));
    return `${symbol.name}<${args.join(', ')}>`;
  }

  private isExternal(symbol: TS.Symbol): boolean {
    const declarations = symbol.declarations ?? [];
    if (declarations.length === 0) return true;
    return declarations.every((declaration) => {
      const file = declaration.getSourceFile();
      return (
        this.program.isSourceFileDefaultLibrary(file) ||
        this.program.isSourceFileFromExternalLibrary(file) ||
        file.fileName.includes('/node_modules/')
      );
    });
  }

  private joinSorted(types: readonly TS.Type[], separator: string, depth: number, path: Set<TS.Type>): string {
    return types
      .map((member) => this.describeType(member, depth, path))
      .sort()
      .join(separator);
  }

  /** The checker's own text for `type`. `ignoreAlias` prints what an alias stands for instead of its name. */
  private typeToString(type: TS.Type, ignoreAlias = false): string {
    const { TypeFormatFlags } = this.ts;
    const flags = TypeFormatFlags.NoTruncation | (ignoreAlias ? TypeFormatFlags.InTypeAlias : 0);
    return this.checker.typeToString(type, undefined, flags);
  }

  /** Removes absolute paths, which the printer writes in `import("...")` types and module names. */
  private sanitize(text: string): string {
    for (const { pattern, to } of this.folders) text = text.replace(pattern, to);
    return text
      .replace(this.projectPrefix, '')
      .replace(/[^\s"'`()<>[\]{},;|&]*\/node_modules\//g, '');
  }
}

function byName(a: TS.Symbol, b: TS.Symbol): number {
  return compare(a.name, b.name);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toSlashes(dir: string): string {
  return dir.replace(/\\/g, '/').replace(/\/+$/, '');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
