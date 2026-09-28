/** Markdown bundled as text by tsup (`loader: { '.md': 'text' }`), e.g. the `nocoproject-user` skill. */
declare module '*.md' {
  const text: string;
  export default text;
}
