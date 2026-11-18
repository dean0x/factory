import type { RequestLink } from '../../src/board/contract.js';
import { canonicalRequestText, requestHashOf } from '../../src/core/request-hash.js';
import { approvalLinkLabels, approvalOptions, relayedMarker, roles } from '../../src/names.js';
import { HOME } from './guard-fixture.js';

export const APPROVAL_ID = 'D-1';
export const APPROVAL_LINK: RequestLink = { point: 'merge', item: 'B-1', ref: '42', head: 'a'.repeat(40) };
const AT = '2030-01-02T03:04:05.678Z';

export const approvalRequest = (id = APPROVAL_ID, link = APPROVAL_LINK) => ({
  id,
  title: 'Private title',
  question: 'Private question',
  options: [{ key: approvalOptions.go, text: 'Go' }, { key: approvalOptions.stop, text: 'Stop' }],
  fields: [
    { label: approvalLinkLabels.point, text: link.point },
    { label: approvalLinkLabels.item, text: link.item },
    { label: approvalLinkLabels.ref, text: link.ref },
    { label: approvalLinkLabels.head, text: link.head },
    { label: 'Reason', text: 'Private field' },
  ],
});

export const approvalRelay = (id = APPROVAL_ID, decision: string = approvalOptions.go, link = APPROVAL_LINK) => ({
  item: `${id}: Private title`, date: '2030-01-02', decision, decider: roles.coordinator, relayed: relayedMarker,
  board_item: link.item, point: link.point, ref: link.ref, head: link.head,
});

export const approvalAnswer = (request = approvalRequest(), option: string = approvalOptions.go) => {
  const text = canonicalRequestText(request);
  if (!text.ok) throw new Error(text.error);
  return {
    row: { item: `${request.id}: ${request.title}`, date: '2030-01-02', decision: approvalOptions.stop, by: roles.owner, request: text.value },
    record: { node: 'demo', root: HOME, id: request.id, option, hash: requestHashOf(text.value), at: AT },
  };
};
