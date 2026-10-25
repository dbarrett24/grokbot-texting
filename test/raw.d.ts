// Vite "?raw" imports (test fixtures read as text).
declare module "*?raw" {
  const text: string;
  export default text;
}
