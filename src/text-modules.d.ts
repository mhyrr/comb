// Bun imports these as strings (`with { type: "text" }`); tsc needs to know.
declare module "*.md" {
  const text: string;
  export default text;
}
