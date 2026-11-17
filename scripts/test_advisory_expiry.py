import datetime as dt
import unittest

from check_advisory_expiry import ADVISORY, EXPIRES_AT, check


class AdvisoryExpiryTests(unittest.TestCase):
    def setUp(self):
        self.deadline = dt.datetime(2027, 2, 17, tzinfo=dt.timezone.utc)
        self.policy = {"advisories": {"ignore": [{"id": ADVISORY}]}}

    def test_boundary(self):
        check(self.policy, EXPIRES_AT, self.deadline - dt.timedelta(microseconds=1))
        for now in (self.deadline, self.deadline + dt.timedelta(microseconds=1)):
            with self.subTest(now=now), self.assertRaises(ValueError):
                check(self.policy, EXPIRES_AT, now)

    def test_removed_exception_does_not_expire(self):
        check({"advisories": {}}, EXPIRES_AT, self.deadline)

    def test_string_ignore_also_expires(self):
        with self.assertRaises(ValueError):
            check({"advisories": {"ignore": [ADVISORY]}}, EXPIRES_AT, self.deadline)

    def test_invalid_inputs_fail_closed(self):
        for expiry in (None, "", "2027-02-17", "2027-02-18T00:00:00Z", "not-a-date"):
            with self.subTest(expiry=expiry), self.assertRaises(ValueError):
                check(self.policy, expiry, self.deadline)
        for policy in ({}, {"advisories": {"ignore": None}}, {"advisories": {"ignore": [{}]}}):
            with self.subTest(policy=policy), self.assertRaises(ValueError):
                check(policy, EXPIRES_AT, self.deadline)
        with self.assertRaises(ValueError):
            check(self.policy, EXPIRES_AT, self.deadline.replace(tzinfo=None))


if __name__ == "__main__":
    unittest.main()
