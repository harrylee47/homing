import { currentTotp } from './src/core/auth.ts'
const secret = process.argv[2]
console.log(await currentTotp(sec