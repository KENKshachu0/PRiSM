-- A bot says everything in one place: the idle warning and what happens at the
-- shop used to have a channel list each, which asked the store to keep two
-- lists in step for no reason. They become one list, `announceChannelIds`, and
-- the idle warning gains a switch of its own (`announceIdle`) beside the
-- existing ones, so which news is told no longer depends on which list it
-- went to.
--
-- Nothing is lost: the two lists are merged, and a bot that was warning about
-- idle power-offs keeps doing so. A bot with nowhere to send idle warnings is
-- left with the switch off; the reminder lead was already derived from the
-- same condition.
UPDATE device_capabilities
SET config_json = json_remove(
  json_set(
    config_json,
    '$.announceChannelIds', (
      SELECT json_group_array(value) FROM (
        SELECT value FROM json_each(json_extract(device_capabilities.config_json, '$.idleChannelIds'))
        UNION
        SELECT value FROM json_each(json_extract(device_capabilities.config_json, '$.eventChannelIds'))
      )
    ),
    '$.announceIdle', CASE
      WHEN json_array_length(json_extract(device_capabilities.config_json, '$.idleChannelIds')) > 0
        AND COALESCE(json_extract(device_capabilities.config_json, '$.idleReminderMinutes'), 0) > 0
      THEN json('true') ELSE json('false') END
  ),
  '$.idleChannelIds', '$.eventChannelIds')
WHERE capability = 'bot';
