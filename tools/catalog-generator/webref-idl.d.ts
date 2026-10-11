declare module '@webref/idl' {
  interface IDLFile {
    shortname: string
    text(): Promise<string>
  }
  export function listAll(): Promise<Record<string, IDLFile>>
}
