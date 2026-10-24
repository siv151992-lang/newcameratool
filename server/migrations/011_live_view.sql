-- Live view (camera pictures in the dashboard): Org Admins and Operators; viewers only see status.
UPDATE roles SET permissions = array_append(permissions, 'cameras:live')
WHERE name IN ('admin', 'operator') AND NOT ('cameras:live' = ANY(permissions));
