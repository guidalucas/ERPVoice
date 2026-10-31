import { requestJson } from './apiClient';
import { normalizePhone } from './phone';
import type { AuthUserProfile, BusinessRole } from './authService';

export type TeamMember = {
  phoneNumber: string;
  role: BusinessRole;
  createdAt: string | null;
};

export type TeamInvite = {
  id: string;
  phoneNumber: string;
  createdAt: string;
  expiresAt: string;
};

export type TeamSnapshot = {
  role: BusinessRole;
  tenantPhone: string;
  businessName: string | null;
  members: TeamMember[];
  invites: TeamInvite[];
};

export const fetchTeam = async () => requestJson<TeamSnapshot>('/api/team');

export const createTeamInvite = async (phoneNumber: string) =>
  requestJson<{
    id: string;
    phoneNumber: string;
    expiresAt: string;
    resent: boolean;
    devMode?: boolean;
  }>('/api/team/invites', {
    method: 'POST',
    body: JSON.stringify({ phoneNumber: normalizePhone(phoneNumber) }),
  });

export const cancelTeamInvite = async (inviteId: string) =>
  requestJson<void>(`/api/team/invites/${encodeURIComponent(inviteId)}`, {
    method: 'DELETE',
  });

export const acceptTeamInvite = async (inviteId: string) =>
  requestJson<AuthUserProfile>(`/api/team/invites/${encodeURIComponent(inviteId)}/accept`, {
    method: 'POST',
  });

export const declineTeamInvite = async (inviteId: string) =>
  requestJson<AuthUserProfile>(`/api/team/invites/${encodeURIComponent(inviteId)}/decline`, {
    method: 'POST',
  });

export const removeTeamMember = async (phoneNumber: string) =>
  requestJson<void>(`/api/team/members/${encodeURIComponent(normalizePhone(phoneNumber))}`, {
    method: 'DELETE',
  });

export const leaveTeam = async () => requestJson<AuthUserProfile>('/api/team/leave', { method: 'POST' });

export const updateTeamMemberRole = async (phoneNumber: string, role: 'admin' | 'member', expectedRole: 'admin' | 'member') =>
  requestJson<{ phoneNumber: string; role: 'admin' | 'member' }>(`/api/team/members/${encodeURIComponent(normalizePhone(phoneNumber))}/role`, {
    method: 'PATCH', body: JSON.stringify({ role, expectedRole }),
  });
