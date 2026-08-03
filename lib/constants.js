const PROPERTY_FIELD_GROUPS = [
  ['price', 'pricevalue', 'listprice', 'list_price', 'askingprice', 'asking_price'],
  ['bedrooms', 'beds', 'bedroomcount', 'numbedrooms', 'no_of_bedrooms'],
  ['bathrooms', 'baths', 'bathroomcount', 'numbathrooms'],
  ['address', 'addresswithcommas', 'address_with_commas', 'displayaddress', 'display_address', 'street', 'streetaddress', 'street_address', 'location'],
  ['sqft', 'squarefeet', 'square_feet', 'floorarea', 'floor_area', 'size'],
  ['propertytype', 'property_type', 'type', 'listingtype'],
  ['images', 'photos', 'photo', 'photosquare', 'propertyindexphotos', 'media', 'gallery'],
  ['description', 'shortdescription', 'short_description', 'summary', 'details'],
  ['title', 'friendly_str', 'displayaddress', 'display_address', 'addresswithcommas', 'address_with_commas', 'name', 'headline'],
  ['url', 'href', 'permalink', 'link', 'detailurl', 'detail_url', 'property_url'],
  ['id', 'listingid', 'listing_id', 'propertyid', 'property_id', 'slug', 'uuid'],
];

const FIELD_ALIASES = {
  id: ['id', 'listingid', 'listing_id', 'propertyid', 'property_id', 'slug', 'uuid'],
  title: ['title', 'friendly_str', 'displayaddress', 'display_address', 'addresswithcommas', 'address_with_commas', 'name', 'headline'],
  description: ['description', 'shortdescription', 'short_description', 'summary', 'details', 'body'],
  price: ['price', 'pricevalue', 'listprice', 'list_price', 'askingprice', 'asking_price'],
  currency: ['currency', 'pricecurrency', 'price_currency'],
  bedrooms: ['bedrooms', 'beds', 'bedroomcount', 'numbedrooms', 'no_of_bedrooms'],
  bathrooms: ['bathrooms', 'baths', 'bathroomcount', 'numbathrooms'],
  sqft: ['sqft', 'squarefeetinternal', 'squarefeet', 'square_feet', 'floorarea', 'floor_area', 'size'],
  propertyType: ['propertytype', 'property_type', 'proptype', 'type', 'listingtype'],
  address: ['address', 'addresswithcommas', 'displayaddress', 'street', 'streetaddress', 'street_address'],
  city: ['city', 'town'],
  state: ['state', 'region', 'county'],
  postcode: ['postcode', 'zip', 'zipcode', 'postalcode', 'postal_code'],
  country: ['country'],
  latitude: ['latitude', 'lat'],
  longitude: ['longitude', 'lng', 'lon', 'long'],
  images: ['images', 'photos', 'propertyindexphotos', 'photo', 'photosquare', 'media', 'gallery'],
  status: ['status', 'listingstatus', 'listing_status'],
  agentName: ['agentname', 'agent_name', 'branchname', 'branch_name', 'officename', 'office_name', 'listedby', 'listed_by'],
  agentEmail: ['agentemail', 'agent_email', 'branchemail', 'branch_email', 'officeemail', 'office_email', 'contactemail', 'contact_email', 'email'],
  agentPhone: ['agentphone', 'agent_phone', 'agentmobile', 'agent_mobile', 'branchphone', 'branch_phone', 'officephone', 'office_phone', 'contactphone', 'contact_phone', 'telephone', 'phone', 'mobile', 'vox_number'],
  agentContact: ['agentcontact', 'agent_contact', 'contactdetails', 'contact_details'],
  sourceUrl: ['url', 'href', 'permalink', 'link', 'detailurl', 'detail_url', 'property_url'],
};

const DOM_PRICE_REGEX = /[£$€]\s?[\d,]+(?:\.\d{2})?|\d{1,3}(?:,\d{3})+(?:\s?(?:pcm|pw|pa|pm))?/i;

const DOM_BEDROOM_REGEX = /(\d+)\s*(?:bed(?:room)?s?|br)\b/i;

const SCHEMA_ORG_PROPERTY_TYPES = [
  'RealEstateListing',
  'Residence',
  'Apartment',
  'House',
  'SingleFamilyResidence',
  'Product',
  'Offer',
  'Place',
];

const NEXT_PAGE_SELECTORS = [
  'a[rel="next"]',
  '.pagination a.next',
  '.pagination .next a',
  '.nav-links a.next',
  'a.next_page',
  'a.nextpostslink',
  '.pager .next a',
  'a[aria-label="Next"]',
  'a[aria-label="Next page"]',
  'li.next a',
  '.page-numbers.next',
];

const LOAD_MORE_SELECTORS = [
  'button.load-more',
  'a.load-more',
  '.load-more [role="button"]',
  '.load-more .button',
  '.load-more button',
  '.load-more a',
  'button[data-action="load-more"]',
  'a.loadmore',
  '#load-more',
  '.loadmore-btn',
];

module.exports = {
  PROPERTY_FIELD_GROUPS,
  FIELD_ALIASES,
  DOM_PRICE_REGEX,
  DOM_BEDROOM_REGEX,
  SCHEMA_ORG_PROPERTY_TYPES,
  NEXT_PAGE_SELECTORS,
  LOAD_MORE_SELECTORS,
};
