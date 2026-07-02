// @dimina-kit/compiler ships no type declarations. The Node disk pool's default export
// is a drop-in for dmcc's build(): same 4-arg signature, resolves undefined on compile
// error (never rethrows), keeps its 3 stage workers warm across rebuilds.
declare module '@dimina-kit/compiler/pool-node' {
	export default function build(
		targetPath: string,
		workPath: string,
		useAppIdDir?: boolean,
		options?: { sourcemap?: boolean, fileTypes?: { template?: string[], style?: string[], viewScript?: string[] } },
	): Promise<{ appId: string, name: string, path: string } | undefined>
}
