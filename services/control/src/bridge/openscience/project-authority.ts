import { assertRoleProject, roleFilesystemGrants, requiredRolePlugin, type RoleProject } from './role-project';
import { isRemoteProject, assertRemoteProject, remoteProjectGrants, remoteProjectPlugin } from './remote-role';

export const assertProject = (project: RoleProject) => isRemoteProject(project) ? assertRemoteProject(project) : assertRoleProject(project);
export const projectGrants = (project: RoleProject) => isRemoteProject(project) ? remoteProjectGrants(project) : roleFilesystemGrants(project);
export const projectPlugin = (project: RoleProject) => isRemoteProject(project) ? remoteProjectPlugin(project) : requiredRolePlugin(project);
