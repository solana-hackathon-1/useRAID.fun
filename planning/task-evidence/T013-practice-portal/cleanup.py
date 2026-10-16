from pathlib import Path
p=Path('tests/practice-portal-db.test.ts');s=p.read_text().replace("import { PrismaClient } from '@prisma/client';\n",'').replace("import { executeIdempotentCommand } from '../src/command-receipts';\n",'').replace('  createPrismaCommandTransaction,\n','').replace('  lockPracticeTrialParticipant,\n','').replace('  PracticeTrialSubmissionStorageError,\n','').replace("import { SkillAssessmentSnapshotSchema } from '../src/skills/assessment-review-contracts';\n",'')
a=s.index('const read =');b=s.index('import {\n  listOwnPracticeTrials',a);s=s[:a]+s[b:]
s=s.replace('(s: any)', '(s: {taxonomyId:string;participantId:string;skillId:string;skillDomain:string})')
p.write_text(s)
p=Path('tests/practice-portal-host.test.ts');s=p.read_text().replace('(_db: any, work: any)','(_db: unknown, work: (tx: object)=>unknown)').replace('(_tx: any, a: any, input: any, canRead: any)','(_tx: unknown, a: unknown, input: unknown, canRead: ()=>boolean)').replace('(_tx: any, _command: any, o: any)',"(_tx: unknown, _command: unknown, o: {allowNewWrites:boolean;canStart:(scope:{taxonomyId:string})=>boolean;canSubmit:()=>boolean})")
p.write_text(s)
p=Path('src/skills/practice-portal-storage.ts');s=p.read_text().replace('    const { publishedByAccountId: _publisher, ...safe } = saved;',"    const safe = {...saved};\n    Reflect.deleteProperty(safe, 'publishedByAccountId');");p.write_text(s)
