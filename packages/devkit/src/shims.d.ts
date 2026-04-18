declare module '@dimina/compiler' {
	export default function build(
		targetPath: string,
		workPath: string,
		useAppIdDir?: boolean,
		options?: { sourcemap?: boolean },
	): Promise<{ appId: string; name: string; path: string } | undefined>
}
