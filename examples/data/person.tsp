@doc("A person (alive, dead, undead, or fictional)")
model Person {
  @doc("Given/first name")
  @tag("classification:PII")
  givenName?: string;
  @doc("Family/last name")
  @tag("classification:PII")
  familyName?: string;
  @doc("Email address")
  @tag("classification:PII")
  email?: string;
  @doc("Phone number")
  @tag("classification:PII")
  telephone?: string;
  @doc("Date of birth")
  @tag("classification:PII")
  birthDate?: string;
  @doc("Physical address")
  @tag("classification:PII")
  address?: string;
  @doc("Gender identity")
  @tag("classification:PII")
  gender?: string;
  @doc("Nationality")
  nationality?: string;
  @doc("Job title or role")
  jobTitle?: string;
  @doc("Organization the person works for")
  worksFor?: string;
  @doc("Personal website URL")
  url?: string;
  @doc("Profile image URL")
  image?: string;
}
