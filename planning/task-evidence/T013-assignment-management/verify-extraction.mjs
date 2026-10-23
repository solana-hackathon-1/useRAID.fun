import ts from 'typescript';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const printer=ts.createPrinter({removeComments:true,newLine:ts.NewLineKind.LineFeed});
const parse=(code)=>{const f=ts.createSourceFile('source.ts',code,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS),map=new Map();for(const node of f.statements){const names=ts.isVariableStatement(node)?node.declarationList.declarations.flatMap(d=>ts.isIdentifier(d.name)?[d.name.text]:[]):node.name&&ts.isIdentifier(node.name)?[node.name.text]:[];for(const name of names)map.set(name,printer.printNode(ts.EmitHint.Unspecified,node,f));}return map;};
const before=path=>parse(execFileSync('git',['show','HEAD:'+path],{encoding:'utf8'})),after=path=>parse(readFileSync(path,'utf8'));
const storage='src/skills/practice-review-assignment-storage.ts',http='src/skills/practice-review-assignment-http.ts',pure='src/skills/practice-review-assignment-contracts.ts';
const oldStorage=before(storage),newStorage=after(storage),oldHttp=before(http),newHttp=after(http),contracts=after(pure),checks=[];
function same(name,a,b){assert.equal(a.get(name),b.get(name),name);checks.push({name,sha256:createHash('sha256').update(a.get(name)).digest('hex')});}
for(const name of ['Timestamp','Reason','PracticeReviewPurposeSchema','IssuePracticeReviewAssignmentInputSchema','RevokePracticeReviewAssignmentInputSchema','PracticeReviewAssignmentRecordSchema','PracticeReviewRevocationRecordSchema','PracticeReviewAssignmentRecord','PracticeReviewRevocationRecord'])same(name,oldStorage,contracts);
for(const name of ['Common','available','PracticeReviewAssignmentIssueResultSchema','PracticeReviewAssignmentRevokeResultSchema'])same(name,oldHttp,contracts);
for(const name of ['UseInput','PracticeReviewAssignmentError','actorValid','query','authorize','preflightManagement','allowed','scopeFor','manage','lockUsers','loadAssignment','loadRevocation','optionsValid','managementFor','issuePracticeReviewAssignment','revokePracticeReviewAssignment','lockPracticeReviewAssignment'])same(name,oldStorage,newStorage);
for(const name of ['PracticeReviewAssignmentHttpError','PracticeReviewAssignmentHttpHost','practiceReviewAssignmentPrivateHeaders','Params','MAXIMUM_BODY_BYTES','fail','failure','createPracticeReviewAssignmentHandlers'])same(name,oldHttp,newHttp);
writeFileSync(new URL('contract-extraction-proof.json',import.meta.url),JSON.stringify({baseline:'0d20d5f',at:new Date().toISOString(),checks,conclusion:'Canonical existing schemas, write/read-use functions and original POST factory are AST-identical. Imports/exports/dependency links changed; new management read/API/UI are additive.'},null,2)+'\n');console.log('AST-identical prior contracts/functions:',checks.length);
