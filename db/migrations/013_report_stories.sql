-- Stories can be reported too (Play's user-generated-content policy: every kind of UGC must be reportable).
ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_target_type_check;
ALTER TABLE reports ADD CONSTRAINT reports_target_type_check CHECK (target_type IN ('user', 'message', 'post', 'story'));
