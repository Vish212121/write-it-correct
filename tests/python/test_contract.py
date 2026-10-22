import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests" / "fixtures"
ALLOWED_TYPES = {"spelling", "grammar", "punctuation", "style", "clarity"}


def read_fixture(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def validate_issue(issue, source_text=None):
    errors = []
    if not isinstance(issue, dict):
        return ["issue must be an object"]
    if not isinstance(issue.get("original"), str) or not issue["original"]:
        errors.append("original must be a non-empty string")
    if not isinstance(issue.get("suggestion"), str):
        errors.append("suggestion must be a string")
    if issue.get("type") not in ALLOWED_TYPES:
        errors.append("type is unsupported")
    if not isinstance(issue.get("message"), str):
        errors.append("message must be a string")
    if (not isinstance(issue.get("start"), int) or isinstance(issue.get("start"), bool)
            or issue["start"] < 0 or not isinstance(issue.get("end"), int)
            or isinstance(issue.get("end"), bool) or issue["end"] <= issue["start"]):
        errors.append("start and end offsets must be valid integers")
    if isinstance(issue.get("suggestion"), str) and issue["suggestion"] == issue.get("original"):
        errors.append("suggestion must change the original text")
    if source_text is not None and isinstance(issue.get("original"), str):
        if issue["original"] not in source_text:
            errors.append("original must occur in source text")
        if isinstance(issue.get("start"), int) and isinstance(issue.get("end"), int):
            if source_text[issue["start"]:issue["end"]] != issue["original"]:
                errors.append("offsets must point to the original text")
    return errors


def locate_non_overlapping(text, issues):
    accepted = []
    for issue in issues:
        start = text.find(issue["original"])
        if start < 0:
            continue
        end = start + len(issue["original"])
        if any(start < item["end"] and end > item["start"] for item in accepted):
            continue
        accepted.append({"issue": issue, "start": start, "end": end})
    return accepted


class ContractTests(unittest.TestCase):
    def test_valid_issue_fixture_follows_contract(self):
        issues = read_fixture("issue-valid.json")
        self.assertTrue(all(not validate_issue(issue) for issue in issues))

    def test_invalid_issue_fixture_is_rejected(self):
        issues = read_fixture("issue-invalid.json")
        self.assertTrue(all(validate_issue(issue) for issue in issues))

    def test_original_values_must_occur_verbatim(self):
        issue = read_fixture("issue-valid.json")[0]
        positioned = {**issue, "start": 9, "end": 12}
        self.assertEqual(validate_issue(positioned, "The word teh is here."), [])
        self.assertIn("offsets must point to the original text", validate_issue(issue, "The word teh is here."))
        self.assertTrue(validate_issue(issue, "The sentence is correct."))

    def test_overlapping_issue_ranges_are_not_accepted_together(self):
        fixture = read_fixture("issue-repeated.json")
        located = locate_non_overlapping(fixture["text"], fixture["issues"])
        self.assertEqual(len(located), 1)
        self.assertEqual(located[0]["issue"]["original"], "teh")

    def test_settings_fixture_has_expected_baseline_shape(self):
        settings = read_fixture("settings.json")
        self.assertIsInstance(settings["groqApiKey"], str)
        self.assertIsInstance(settings["model"], str)
        self.assertIsInstance(settings["language"], str)


if __name__ == "__main__":
    unittest.main()
